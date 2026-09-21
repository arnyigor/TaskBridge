/**
 * Smoke шага 5: shadow-эпизоды с фронтовым триггером.
 *
 *   node bench/test-shadow-episodes.mjs
 *
 * Зачем: раньше `block_shadow` писался на КАЖДОМ шаге, пока условие держалось. Один длинный
 * заскок модели выглядел как N независимых срабатываний, и частота гейта была недостоверна —
 * а именно по частоте принимается решение «гейт нужен / гейт удалить».
 *
 * Здесь проверяется логика эпизодов на чистом условии `gateConditions` (функция ТОЛЬКО от
 * состояния, без инструмента) и модель open/close поверх неё. Живая проводка в supervisor.ts
 * проверяется секцией E по тексту — как в test-artifact-flow.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTsTypes, grabFunction } from './lib-ts-extract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'supervisor.ts'), 'utf8');

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ок  ' : 'ОШИБКА'}    ${name}${detail ? `  — ${detail}` : ''}`);
};

const api = new Function(`${stripTsTypes([
  grabFunction(src, 'isBashWrite'),
  grabFunction(src, 'gateConditions'),
].join('\n'))}; return { gateConditions };`)();

const S = { stagnationAfter: 10, editsBeforeVerifyBlock: 4, blocking: true, readOnly: false, shadow: true, shadowWindow: 8 };
const st = (over = {}) => ({
  state: 'greenfield', toolName: '', command: '', writtenPaths: [], edits: 0,
  projectFiles: 0, draftFiles: 0, verifications: 0, lastVerifiedEdits: 0, lastVerifiedTouched: 0,
  reproSeenInContext: false, steps: 0, stepsSinceProgress: 0, S, ...over,
});

// Модель трекера из supervisor.ts: эпизод на гейт, открытие на фронте, закрытие на спаде.
function track(timeline) {
  const episodes = new Map();
  const log = [];
  let n = 0;
  for (const state of timeline) {
    const open = new Set(api.gateConditions(state));
    for (const gate of open) {
      if (episodes.has(gate)) {
        const e = episodes.get(gate);
        if (!e.persisted && state.steps - e.openedAtStep >= S.shadowWindow) {
          e.persisted = true;
          log.push({ event: 'persisted', gate, id: e.id, stepsOpen: state.steps - e.openedAtStep });
        }
        continue;
      }
      n += 1;
      const e = { id: `${gate}-${n}`, gate, openedAtStep: state.steps, files: state.projectFiles, verifies: state.verifications, persisted: false, openState: state.state };
      episodes.set(gate, e);
      log.push({ event: 'opened', gate, id: e.id, atStep: state.steps });
    }
    for (const [gate, e] of [...episodes]) {
      if (open.has(gate)) continue;
      episodes.delete(gate);
      const verifiesSince = state.verifications - e.verifies;
      const filesSince = state.projectFiles - e.files;
      const resolution = verifiesSince > 0 ? 'verification'
        : filesSince > 0 ? 'productive_write'
        : state.state !== e.openState ? 'phase_changed'
        : 'condition_cleared';
      log.push({ event: 'closed', gate, id: e.id, resolution, stepsOpen: state.steps - e.openedAtStep, persisted: e.persisted });
    }
  }
  return { log, stillOpen: [...episodes.keys()] };
}

const opened = log => log.filter(x => x.event === 'opened');
const closed = log => log.filter(x => x.event === 'closed');

// ─── A. Условие держится 12 шагов = ОДИН эпизод ─────────────────────────────
console.log('\nA. Длинный заскок — один эпизод, а не двенадцать');
{
  const timeline = [];
  for (let s = 8; s <= 20; s += 1) timeline.push(st({ steps: s, stepsSinceProgress: s }));   // застой истинен с шага 10
  const { log, stillOpen } = track(timeline);
  check('открытий ровно одно', opened(log).length === 1, JSON.stringify(opened(log)));
  check('открыт на шаге порога (10), а не раньше', opened(log)[0]?.atStep === 10, String(opened(log)[0]?.atStep));
  check('persisted записан один раз', log.filter(x => x.event === 'persisted').length === 1, '');
  check('эпизод остался открытым к концу прогона', stillOpen.includes('stagnation'), stillOpen.join(','));
}

// ─── B. Модель исправилась сама: closed с причиной ──────────────────────────
console.log('\nB. Модель сама создала файл — эпизод закрылся');
{
  const timeline = [
    st({ steps: 9, stepsSinceProgress: 9 }), st({ steps: 10, stepsSinceProgress: 10 }),
    st({ steps: 11, stepsSinceProgress: 11 }), st({ steps: 12, stepsSinceProgress: 12 }),
    st({ steps: 13, stepsSinceProgress: 0, projectFiles: 1 }),   // появился файл проекта — сдвиг
  ];
  const { log } = track(timeline);
  check('один эпизод открыт и закрыт', opened(log).length === 1 && closed(log).length === 1, '');
  check('причина закрытия — продуктивная запись', closed(log)[0]?.resolution === 'productive_write', closed(log)[0]?.resolution);
  check('латентность самовосстановления = 3 шага', closed(log)[0]?.stepsOpen === 3, String(closed(log)[0]?.stepsOpen));
  check('до окна persist не дошло', !closed(log)[0]?.persisted, '');
}

// ─── C. Повторный вход = НОВЫЙ эпизод ───────────────────────────────────────
console.log('\nC. Условие ушло и вернулось');
{
  const timeline = [
    st({ steps: 10, stepsSinceProgress: 10 }),                      // застой открыт
    st({ steps: 11, stepsSinceProgress: 0, projectFiles: 1 }),       // сдвиг — закрыт
    st({ steps: 12, stepsSinceProgress: 1, projectFiles: 1, lastVerifiedTouched: 0 }),  // пока тихо
    st({ steps: 13, stepsSinceProgress: 0, projectFiles: 4, lastVerifiedTouched: 0 }),  // verify-delta открыт (4 >= 4)
    st({ steps: 14, stepsSinceProgress: 0, projectFiles: 4, lastVerifiedTouched: 4, verifications: 1 }), // проверилась
    st({ steps: 15, stepsSinceProgress: 0, projectFiles: 9, lastVerifiedTouched: 4, verifications: 1 }), // снова накопила
  ];
  const { log } = track(timeline);
  const ids = opened(log).map(x => x.id);
  check('три отдельных эпизода', ids.length === 3, ids.join(', '));
  check('два из них — verify-delta с РАЗНЫМИ id',
    ids.filter(i => i.startsWith('verify-delta')).length === 2 && new Set(ids).size === 3, ids.join(', '));
  check('первый verify-delta закрылся проверкой',
    closed(log).find(x => x.gate === 'verify-delta')?.resolution === 'verification', '');
}

// ─── D. Два гейта одновременно — независимые эпизоды ────────────────────────
console.log('\nD. Параллельные гейты не затирают друг друга');
{
  // baseline_red без своего прогона + накопленная непроверенная дельта.
  const timeline = [
    st({ steps: 5, state: 'baseline_red', projectFiles: 5, lastVerifiedTouched: 0 }),
    st({ steps: 6, state: 'baseline_red', projectFiles: 5, lastVerifiedTouched: 0, reproSeenInContext: true }),
  ];
  const { log, stillOpen } = track(timeline);
  const gates = opened(log).map(x => x.gate).sort();
  check('открыты оба гейта', gates.join(',') === 'repro,verify-delta', gates.join(','));
  check('repro закрылся, verify-delta остался открыт',
    closed(log).length === 1 && closed(log)[0].gate === 'repro' && stillOpen.join(',') === 'verify-delta',
    `closed=${closed(log).map(x => x.gate)} open=${stillOpen}`);
}

// ─── E. Проводка в supervisor.ts ────────────────────────────────────────────
console.log('\nE. Живой код действительно фронтовой');
{
  const body = src.slice(src.indexOf('const syncEpisodes'), src.indexOf('const maybeNudge'));
  check('эпизоды хранятся по гейту (Map), а не одним слотом',
    /episodes\.has\(gate\)/.test(body) && /episodes\.set\(gate/.test(body), '');
  check('пока условие держится — нового opened нет',
    /if \(episodes\.has\(gate\)\) \{[\s\S]*?continue;/.test(body), '');
  check('старого per-step block_shadow-слота больше нет', !/pendingShadow/.test(src), '');
  check('условие считается без имени инструмента',
    /gateConditions\(currentInput\(\)\)/.test(body), '');
  const tool = src.slice(src.indexOf("pi.on('tool_call'"), src.indexOf("pi.on('tool_execution_end'"));
  check('повтор внутри эпизода идёт в retriggers, а не в новое событие',
    /live\.retriggers \+= 1/.test(tool), '');
}

console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nэпизоды фронтовые: один заскок — один эпизод');
process.exit(failed ? 1 : 0);
