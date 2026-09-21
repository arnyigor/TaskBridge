/**
 * Smoke шага 8: прогресс ≠ активность, застой вместо «ноль файлов».
 *
 *   node bench/test-progress.mjs
 *
 * Что заменено и почему. Условие `projectFiles === 0` — это СОСТОЯНИЕ ДЕРЕВА, и оно умирает
 * после любой массовой материализации: в живом прогоне `unzip` шаблона дал 43 файла класса
 * PROJECT, гейт замолчал навсегда, а модель 56 шагов ходила по `curl` без единой правки —
 * ровно тот случай, против которого гейт и делался.
 *
 * Новое условие — ДИНАМИКА: шагов с последнего сдвига наблюдаемого состояния. Сколько файлов
 * уже лежит, не важно; кто их создал — тоже (никакой атрибуции unzip/git clone/gradle init).
 *
 * Главная тонкость, которую этот тест и стережёт: повторный провал с ТОЙ ЖЕ подписью
 * прогрессом не является. Иначе цикл test→FAIL(A)→read→test→FAIL(A) держал бы счётчик
 * застоя у нуля, а модель при этом стоит.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stripTsTypes, grabFunction } from './lib-ts-extract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'supervisor.ts'), 'utf8');

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ок  ' : 'ОШИБКА'}    ${name}${detail ? `  — ${detail}` : ''}`);
};

const need = re => {
  const m = src.match(re);
  if (!m) throw new Error(`не найдено в supervisor.ts: ${re}`);
  return m[0];
};

// Живые функции: подпись сбоя и условие гейта.
const api = new Function('createHash', `${stripTsTypes([
  need(/const hashLine = [^\n]+;/),
  grabFunction(src, 'failureSignature'),
  grabFunction(src, 'isBashWrite'),
  grabFunction(src, 'gateConditions'),
].join('\n'))}; return { failureSignature, gateConditions };`)(createHash);

const S = { stagnationAfter: 6, editsBeforeVerifyBlock: 99, blocking: true, readOnly: false, shadow: true, shadowWindow: 8 };
const st = (over = {}) => ({
  state: 'greenfield', toolName: '', command: '', writtenPaths: [], edits: 0,
  projectFiles: 0, draftFiles: 0, verifications: 0, lastVerifiedTouched: 0,
  reproSeenInContext: false, steps: 0, stepsSinceProgress: 0, S, ...over,
});

// ─── A. Условие не зависит от числа файлов ──────────────────────────────────
console.log('\nA. Застой считается динамикой, а не уровнем');
{
  // Тот самый живой случай: 43 файла из распаковки, дальше сплошной curl.
  const stuck = api.gateConditions(st({ projectFiles: 43, stepsSinceProgress: 20, steps: 56 }));
  check('43 файла из unzip + 20 шагов без сдвига → гейт открыт', stuck.includes('stagnation'), stuck.join(','));
  const empty = api.gateConditions(st({ projectFiles: 0, stepsSinceProgress: 0, steps: 40 }));
  check('ноль файлов, но сдвиг только что был → гейт молчит', !empty.includes('stagnation'), empty.join(','));
  const old = api.gateConditions(st({ projectFiles: 9999, stepsSinceProgress: 7, steps: 200 }));
  check('количество уже лежащих файлов на решение не влияет', old.includes('stagnation'), old.join(','));
}

// ─── B. Подпись сбоя: та же ошибка ≠ сдвиг ──────────────────────────────────
console.log('\nB. Подпись сбоя');
{
  const failA1 = 'e: file:///src/A.kt:12:5 unresolved reference: foo\nBUILD FAILED in 31s';
  const failA2 = 'e: file:///src/A.kt:12:5 unresolved reference: foo\nBUILD FAILED in 44s';  // другое время
  const failB = 'e: file:///src/B.kt:7:1 type mismatch: inferred type is Int\nBUILD FAILED in 30s';
  const sig = o => api.failureSignature('compile_errors', o);
  check('та же ошибка, другое время сборки → подпись та же', sig(failA1) === sig(failA2), sig(failA1));
  check('другая ошибка → подпись другая', sig(failA1) !== sig(failB), `${sig(failA1)} vs ${sig(failB)}`);
  check('успех отличается от провала', sig(failA1) !== api.failureSignature('success', 'BUILD SUCCESSFUL in 20s'), '');
  // Номера строк вычищаются: сдвиг ошибки на строку — не новая ошибка.
  const shifted = 'e: file:///src/A.kt:19:5 unresolved reference: foo\nBUILD FAILED in 31s';
  check('сместившийся номер строки не выдаёт себя за новую ошибку', sig(failA1) === sig(shifted), '');
}

// ─── C. Сценарий целиком ────────────────────────────────────────────────────
console.log('\nC. Полная траектория: где сдвиг, а где его нет');
{
  // Трекер берётся из ЖИВОГО supervisor.ts, а не пишется заново: копия модели пропускала
  // мутации ядра насквозь (проверено — подмена подписи на случайную проходила незамеченной).
  const block = src.slice(src.indexOf('  let lastProgressStep = 0;'), src.indexOf('  // ─── Final verify'));
  if (!/noteVerification/.test(block)) throw new Error('блок прогресса не найден в supervisor.ts');
  const progress = [];
  const live = new Function('failureSignature', 'record', `
    let steps = 0;
    ${stripTsTypes(block)}
    return {
      setStep: n => { steps = n; },
      noteProgress, noteVerification, stepsSinceProgress,
    };`)(api.failureSignature, (event, extra) => { if (event === 'progress') progress.push([extra.kind, extra.detail]); });

  const step = (n, kind, payload = '') => {
    live.setStep(n);
    if (kind === 'mutation') { live.noteProgress('project_mutation', 'src/X.kt'); return; }
    if (kind === 'verify') { live.noteVerification('fail', payload.kind, payload.out); return; }
    // read / curl / grep — активность, но не прогресс: трекер не трогаем вовсе
  };
  const failA = 'e: file:///src/A.kt:12:5 unresolved reference: foo';
  const failB = 'e: file:///src/B.kt:3:1 type mismatch';

  step(1, 'read'); step(2, 'curl');
  step(3, 'mutation');                                   // unzip шаблона — сдвиг
  step(4, 'read'); step(5, 'grep');
  step(6, 'verify', { kind: 'compile_errors', out: failA });  // первая проверка — сдвиг
  step(7, 'read');
  step(8, 'verify', { kind: 'compile_errors', out: failA });  // ТА ЖЕ ошибка — НЕ сдвиг
  step(9, 'read');
  // Замер берём ЗДЕСЬ, по ходу траектории: счётчик нельзя «отмотать» назад после шага 11.
  const gapAt9 = live.stepsSinceProgress();
  step(10, 'mutation');                                  // правка — сдвиг
  step(11, 'verify', { kind: 'compile_errors', out: failB }); // ошибка сменилась — сдвиг

  const kinds = progress.map(p => p[0]);
  check('ровно четыре сдвига', progress.length === 4, JSON.stringify(kinds));
  check('это мутация, первая проверка, мутация, смена ошибки',
    kinds.join(',') === 'project_mutation,verification_changed,project_mutation,verification_changed', kinds.join(','));
  // Ключевая проверка смысла: повтор ТОГО ЖЕ провала (шаг 8) сдвигом не признан.
  check('повтор того же провала сдвигом не признан', progress.length === 4, `сдвигов ${progress.length}, ожидалось 4`);
  // Сдвиг был на шаге 6, повтор на 8 его не сбросил → к шагу 9 накоплено 3.
  check('повтор провала не обнулил счётчик: к шагу 9 накоплено 3', gapAt9 === 3, String(gapAt9));
  check('после смены ошибки (шаг 11) счётчик обнулён', live.stepsSinceProgress() === 0, String(live.stepsSinceProgress()));
}

// ─── D. Проводка в supervisor.ts ────────────────────────────────────────────
console.log('\nD. Живая проводка');
{
  // Комментарии не считаем — важен код. Иначе объяснение «почему убрали projectFiles === 0»
  // само бы и валило проверку (поймано на первом прогоне теста).
  const code = src.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('условия гейта больше не смотрят на число файлов',
    !/projectFiles === 0/.test(code), (code.match(/^.*projectFiles === 0.*$/m) ?? [''])[0].trim().slice(0, 60));
  check("гейт называется stagnation, 'recon' из ядра убран",
    /open\.push\('stagnation'\)/.test(code) && !/'recon'/.test(code), '');
  const cond = src.slice(src.indexOf('function gateConditions'), src.indexOf('const GATE_REASON'));
  check('условие — шаги без сдвига', /i\.stepsSinceProgress >= i\.S\.stagnationAfter/.test(cond), '');

  // Мутация PROJECT сбрасывает счётчик, мутация GENERATED — нет: burstAdd вызывается
  // только для класса PROJECT (см. test-write-bursts), а noteProgress живёт внутри него.
  const burstAdd = src.slice(src.indexOf('const burstAdd'), src.indexOf('const closeBurst'));
  check('прогресс отмечается внутри burstAdd (значит только для PROJECT)',
    /noteProgress\('project_mutation'/.test(burstAdd), '');

  // Проверка сбрасывает счётчик только через noteVerification, а та сверяет подпись.
  const noteV = src.slice(src.indexOf('const noteVerification'), src.indexOf('// ─── Final verify'));
  check('проверка сбрасывает застой только при смене подписи',
    /if \(sig !== lastFailureSignature\)/.test(noteV) && /noteProgress\('verification_changed'/.test(noteV), '');
  // Подпись обязана считаться настоящей функцией: случайная строка делала бы прогрессом
  // ЛЮБУЮ проверку (поймано мутацией — проверка на `if (sig !== ...)` этого не видит).
  check('подпись берётся из failureSignature, а не откуда попало',
    /const sig = `\$\{result\}\/\$\{failureSignature\(kind, output\)\}`;/.test(noteV), '');
  // В гейт подаётся ЖИВОЙ счётчик, а не константа.
  const cur = src.slice(src.indexOf('const currentInput'), src.indexOf('const syncEpisodes'));
  check('gateConditions получает живой счётчик застоя',
    /stepsSinceProgress: stepsSinceProgress\(\)/.test(cur), '');
  check('все три точки проверки идут через noteVerification',
    (src.match(/^\s+noteVerification\(/gm) ?? []).length === 3, String((src.match(/^\s+noteVerification\(/gm) ?? []).length));

  // Шаги — для порога, время — рядом как факт (иначе прогоны на разных квантах несравнимы).
  check('в лог пишется и шаги, и миллисекунды застоя',
    /stepsSinceProgress: stepsSinceProgress\(\), msSinceProgress:/.test(src), '');
  // Именно в BASE: в PROFILES тоже есть stagnationAfter: 24, и проверка на любое вхождение
  // не замечала подмены умолчания (поймано мутацией).
  const base = src.slice(src.indexOf('const BASE'), src.indexOf('const PROFILES'));
  check('порог N не подобран заново — умолчание прежнее (24)',
    /stagnationAfter: 24,/.test(base), (base.match(/stagnationAfter: \d+/) ?? [''])[0]);
}

console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nзастой считается сдвигом состояния, а не количеством файлов');
process.exit(failed ? 1 : 0);
