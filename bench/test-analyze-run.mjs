/**
 * Проверка анализатора журнала: node bench/test-analyze-run.mjs
 *
 * Анализатор — единственное место, где считаются метрики, поэтому его ошибка неотличима от
 * ошибки ядра: и то и другое выглядит как «странная цифра в сводке». Фикстура собрана так,
 * чтобы каждая опасная деталь имела ровно один представитель.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ок  ' : 'ОШИБКА'}    ${name}${detail ? `  — ${detail}` : ''}`);
};

const L = [];
let seq = 0;
const e = (event, x = {}) => L.push(JSON.stringify({ event, eventSchemaVersion: 1, seq: (seq += 1), steps: seq, ...x }));
e('session_start');
e('first_project_artifact', { steps: 13, minutes: 4.2, path: 'src/Main.kt', draftsBefore: 2 });
// Эпизод, из которого модель вышла сама, и эпизод, оставшийся открытым к концу прогона.
e('shadow_episode_opened', { episodeId: 'recon-0001', gate: 'recon' });
e('shadow_episode_closed', { episodeId: 'recon-0001', gate: 'recon', resolution: 'productive_write', stepsOpen: 3, persisted: false });
e('shadow_episode_opened', { episodeId: 'verify-delta-0002', gate: 'verify-delta' });
e('shadow_episode_persisted', { episodeId: 'verify-delta-0002', gate: 'verify-delta', stepsOpen: 8 });
// Отрезки: обычный, пустой (не идёт в кривую), длинный хвост, поломка стенда (исключается).
e('write_burst_closed', { burstId: 1, mutations: 3, uniqueFiles: 2, verification: { kind: 'bash', result: 'fail' }, censored: false });
e('write_burst_closed', { burstId: 2, mutations: 0, uniqueFiles: 0, verification: { kind: 'bash', result: 'pass' }, censored: false });
e('write_burst_closed', { burstId: 3, mutations: 12, uniqueFiles: 7, verification: { kind: 'bash', result: 'fail' }, censored: false });
e('write_burst_closed', { burstId: 4, mutations: 2, uniqueFiles: 2, verification: { kind: 'gate', result: 'infra_error' }, censored: false });
e('turn_finish', { wouldBlock: false, mutationsSinceSuccessfulVerify: 0, uniqueFilesSinceSuccessfulVerify: 0, lastVerificationResult: 'pass' });
e('turn_finish', { wouldBlock: true, mutationsSinceSuccessfulVerify: 12, uniqueFilesSinceSuccessfulVerify: 7, lastVerificationResult: 'fail' });
// Последний turn_end несёт ОТКРЫТЫЙ отрезок: самые длинные burst'ы не закрываются никогда,
// и без этой строки правый хвост распределения теряется целиком.
e('turn_end', { stepsSinceProgress: 31, msSinceProgress: 60000, lastProgressKind: 'project_mutation', openBurstMutations: 29, openBurstFiles: 21 });

const dir = 'C:/temp/analyze-smoke';
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'fake.ndjson');
fs.writeFileSync(file, `${L.join('\n')}\n`);
const out = execFileSync('node', [path.join(here, 'analyze-run.mjs'), file], { encoding: 'utf8' });

check('первый артефакт остался как диагностика', /диагностически — первый артефакт: шаг 13/.test(out), '');
// Главная величина greenfield — застой, а не «когда появился файл»: в реальной серии первым
// артефактом в одном прогоне оказалась распаковка шаблона, в других — свой файл.
check('максимальный застой показан', /МАКСИМАЛЬНЫЙ застой: \d+ шагов/.test(out), '');
check('эпизод, из которого модель вышла сама', /recon\s+эпизодов 1, сам вышел 1/.test(out), '');
// Открытый без закрытия = прогон кончился внутри проблемного состояния. Самый сильный сигнал,
// и он не должен потеряться из-за того, что парного события нет.
check('зависший эпизод не потерян', /verify-delta\s+эпизодов 1, сам вышел 0, ЗАВИС до конца 1/.test(out), '');
check('латентность самовосстановления показана', /латентность: 3 шагов/.test(out), '');
check('пустой отрезок исключён из кривой', /отрезков 3 \(пустых 1/.test(out), '');
check('виден хвост, а не только среднее', /длины: 2, 3, 12\s+медиана 3, макс 12/.test(out), '');
check('поломка стенда исключена из кривой', /исключено как поломка стенда: 1/.test(out), '');
// При n=1 проценты — самообман. Анализатор обязан это говорить, а не печатать «100%».
check('при малом n проценты не печатаются', /мало данных, проценты не считаем/.test(out) && !/→ 100%/.test(out), '');
check('открытый отрезок показан отдельно', /ОТКРЫТЫЙ отрезок на конец прогона: 29 мутаций \(файлов 21\)/.test(out), '');
check('грязный финиш назван грязным', /ПОСЛЕДНЕЕ завершение: ГРЯЗНОЕ/.test(out), '');
check('доля грязных завершений посчитана', /завершений хода 2, из них с непроверенным деревом 1/.test(out), '');

// Прогон с включённой блокировкой: длины отрезков ограничены сверху самим гейтом.
const cens = [...L];
cens.push(JSON.stringify({ event: 'write_burst_closed', eventSchemaVersion: 1, seq: 99, steps: 99, burstId: 5, mutations: 4, uniqueFiles: 4, verification: { kind: 'bash', result: 'fail' }, censored: true }));
const file2 = path.join(dir, 'censored.ndjson');
fs.writeFileSync(file2, `${cens.join('\n')}\n`);
const out2 = execFileSync('node', [path.join(here, 'analyze-run.mjs'), file2], { encoding: 'utf8' });
check('цензурированные отрезки помечены предупреждением', /ВНИМАНИЕ: 1 отрезков упёрлись в включённый гейт/.test(out2), '');

// Пустой и битый журнал не должны валить анализ.
const file3 = path.join(dir, 'broken.ndjson');
fs.writeFileSync(file3, 'не json\n{"event":"session_start","eventSchemaVersion":1,"seq":1}\n');
const out3 = execFileSync('node', [path.join(here, 'analyze-run.mjs'), file3], { encoding: 'utf8' });
check('битая строка не ломает разбор', /событий 1/.test(out3), out3.slice(0, 60));

console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nанализатор читает журнал и показывает хвост, а не среднее');
process.exit(failed ? 1 : 0);
