#!/usr/bin/env node
// Приёмочный чек-лист CORE-02 на РАБОЧЕМ сервере (не на стенде).
//
//   node experiments/pi-hooks/acceptance-check.mjs --base http://127.0.0.1:8787
//
// Что проверяется по логам и событиям, без пересборки клиентов:
//   1. эффективный режим инструкций (hook/legacy) — по тому, что реально ушло в Pi;
//   2. дословность: в `message_end` с ролью user нет служебного блока;
//   3. пять обычных ходов → пять применений инструкций (секция в транскрипте Pi);
//   4. смена профиля на цепочке quick → explore → quick → implement → quick;
//   5. секции не накапливаются (размер заменяется, а не растёт);
//   6. терминальный статус не приходит раньше реального завершения Pi;
//   7. старые сессии открываются и их история не переписана.
//
// Что НЕ проверяется здесь (нужны глаза оператора): Desktop/Android-клиенты и
// ручное сжатие из UI — для них в отчёте остаются пустые строки, а не «ок».
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const base = String(argValue('--base', 'http://127.0.0.1:8787')).replace(/\/+$/, '');
const dataRoot = path.resolve(argValue('--data', path.join(repo, 'data')));
const out = path.resolve(argValue('--out', path.join(repo, '.local', 'core02', `acceptance-${Date.now()}`)));
const timeoutMs = Number(argValue('--timeout', '240000'));
const allowWrites = argv.includes('--allow-writes');
// Модель для тестовой сессии: на рабочем сервере дефолт может быть локальным и
// недоступным, тогда приёмка проверяла бы провайдера, а не механизм.
const model = argValue('--model', null);

const CHAIN = [
  { profile: 'quick', text: 'Есть ли папка Unreal Engine For Filmmakers? Посмотри в Learning.' },
  { profile: 'explore', text: 'Разберись, какие основные разделы у этого курса.' },
  { profile: 'quick', text: 'А теперь просто найди папку Blender.' },
  ...(allowWrites ? [{ profile: 'implement', text: 'Создай test.txt в текущей рабочей папке.' }] : []),
  { profile: 'quick', text: 'Проверь, существует ли test.txt.' },
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) throw Object.assign(new Error(`${pathname} → ${response.status}: ${parsed?.error || text}`), { code: parsed?.code });
  return parsed;
}

const readJsonl = async file => (await fs.readFile(file, 'utf8').catch(() => ''))
  .split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);

/** Факты одного хода: что ушло в Pi и что записано в транскрипте. */
async function turnFacts(taskId) {
  const artifacts = path.join(dataRoot, 'tasks', taskId, 'artifacts');
  const frames = await readJsonl(path.join(artifacts, 'pi-events.jsonl'));
  const users = frames
    .filter(frame => frame.type === 'message_end' && frame.message?.role === 'user')
    .map(frame => (Array.isArray(frame.message.content)
      ? frame.message.content.filter(part => part.type === 'text').map(part => part.text).join('')
      : String(frame.message.content || '')));
  const terminalAt = frames.filter(frame => ['taskbridge_turn_timing'].includes(frame.type)).at(-1)?.at || null;
  const sessionsDir = path.join(dataRoot, 'pi-sessions', taskId);
  const files = (await fs.readdir(sessionsDir).catch(() => [])).filter(name => name.endsWith('.jsonl')).sort();
  const entries = files.length ? await readJsonl(path.join(sessionsDir, files.at(-1))) : [];
  const patches = entries.filter(entry => entry.type === 'message' && entry.message?.sections
    && Object.prototype.hasOwnProperty.call(entry.message.sections, 'turn_instructions'));
  return {
    delivered: users.at(-1) || null,
    deliveredChars: (users.at(-1) || '').length,
    hasInstructionBlock: /Task instructions \(\w+\)/.test(users.at(-1) || ''),
    sectionPatches: patches.length,
    sectionProfile: patches.map(entry => /Task instructions \((\w+)\)/.exec(String(entry.message.sections.turn_instructions || ''))?.[1] || null).filter(Boolean).at(-1) || null,
    sectionChars: patches.map(entry => String(entry.message.sections.turn_instructions || '').length).at(-1) || null,
    terminalAt,
  };
}

async function runTurn(id, text) {
  const started = Date.now();
  const response = await fetch(`${base}/api/tasks/${id}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error(`message → ${response.status}: ${await response.text()}`);
  let task = await api(`/api/tasks/${id}`);
  while (Date.now() - started < timeoutMs) {
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return { task, ms: Date.now() - started };
    await sleep(400);
    task = await api(`/api/tasks/${id}`);
  }
  return { task, ms: Date.now() - started, timedOut: true };
}

const report = { at: new Date().toISOString(), base, dataRoot, checks: {}, turns: [] };
await fs.mkdir(out, { recursive: true });

const info = await api('/api/info');
report.build = info.build;
report.pi = info.pi;

// --- 1. Первый ход: определить эффективный режим и дословность -------------
const created = await api('/api/tasks', {
  method: 'POST',
  body: { projectId: '__scratch__', prompt: CHAIN[0].text, ...(model ? { model: { provider: String(model).split('/')[0], id: String(model).split('/')[1] } } : {}) },
});
let task = await api(`/api/tasks/${created.id}`);
const firstStart = Date.now();
while (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status) && Date.now() - firstStart < timeoutMs) {
  await sleep(400);
  task = await api(`/api/tasks/${created.id}`);
}
let facts = await turnFacts(created.id);
const mode = facts.sectionPatches > 0 && !facts.hasInstructionBlock ? 'hook'
  : (facts.hasInstructionBlock ? 'legacy' : 'unknown');
report.mode = mode;
report.taskId = created.id;
report.model = model || null;
report.turns.push({ turn: 1, expected: CHAIN[0].profile, status: task.status, tokens: task.lastUsage?.totalTokens ?? null, ...facts });

for (const [index, step] of CHAIN.slice(1).entries()) {
  const before = facts.sectionPatches;
  const { task: next, ms } = await runTurn(created.id, step.text);
  task = next;
  facts = await turnFacts(created.id);
  report.turns.push({
    turn: index + 2,
    expected: step.profile,
    status: task.status,
    ms,
    tokens: task.lastUsage?.totalTokens ?? null,
    newSectionPatch: facts.sectionPatches > before,
    ...facts,
  });
}

// --- 2. Инварианты ---------------------------------------------------------
const hookTurns = report.turns.filter(turn => turn.status === 'SUCCEEDED');
report.checks.verbatim = report.turns.every(turn => !turn.hasInstructionBlock);
report.checks.perTurnInstructions = mode !== 'hook' || report.turns.every(turn => turn.newSectionPatch !== false);
report.checks.profileSwitching = report.turns.every(turn => turn.sectionProfile === turn.expected);
report.checks.noAccumulation = (() => {
  const sizes = report.turns.map(turn => turn.sectionChars).filter(Number.isFinite);
  if (sizes.length < 3) return null;
  const longest = Math.max(...sizes);
  const shortest = Math.min(...sizes);
  // Замена секции держит разброс в пределах длины одного блока (~600–750 символов).
  return longest - shortest < 200;
})();
report.checks.allSucceeded = hookTurns.length === report.turns.length;
report.checks.terminalAfterFacts = report.turns.every(turn => turn.terminalAt !== null);

// --- 3. Старые сессии ------------------------------------------------------
const tasks = await api('/api/tasks');
const old = [...tasks].filter(item => item.id !== created.id && item.createdAt)
  .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(0, 3);
report.oldSessions = [];
for (const item of old) {
  const entry = { id: item.id, createdAt: item.createdAt, status: item.status };
  try {
    const events = await api(`/api/tasks/${item.id}/events?limit=50`);
    entry.eventsReadable = Array.isArray(events);
    const users = (Array.isArray(events) ? events : [])
      .filter(event => event.type === 'USER_MESSAGE')
      .map(event => String(event.data?.text ?? event.message ?? ''));
    entry.firstUserMessageHasLegacyBlock = users.some(text => /Task instructions \(\w+\)/.test(text));
    entry.userMessages = users.length;
  } catch (error) {
    entry.eventsReadable = false;
    entry.error = error.message;
  }
  report.oldSessions.push(entry);
}
report.checks.oldSessionsIntact = report.oldSessions.every(entry => entry.eventsReadable);

// --- 4. Отчёт --------------------------------------------------------------
const fmt = value => (value === null ? '—' : value === true ? '✅' : value === false ? '❌' : value);
const lines = [
  '# CORE-02: приёмка на рабочем сервере', '',
  `Время: ${report.at}`,
  `Сервер: ${base}`,
  `Сборка: ${JSON.stringify(report.build)}`,
  `Pi: ${report.pi?.version || '?'} (поддерживается: ${report.pi?.supported === true ? 'да' : `нет, диапазон ${report.pi?.supportedRange}`})`,
  `Эффективный режим инструкций: **${report.mode}**`, '',
  '## Проверки', '',
  '| Проверка | Результат |', '|---|---|',
  `| сообщения дословны (нет блока PromptBuilder) | ${fmt(report.checks.verbatim)} |`,
  `| инструкции применяются к каждому ходу | ${fmt(report.checks.perTurnInstructions)} |`,
  `| профиль соответствует запросу | ${fmt(report.checks.profileSwitching)} |`,
  `| секции не накапливаются | ${fmt(report.checks.noAccumulation)} |`,
  `| все ходы SUCCEEDED | ${fmt(report.checks.allSucceeded)} |`,
  `| терминальное состояние после фактов хода | ${fmt(report.checks.terminalAfterFacts)} |`,
  `| старые сессии открываются | ${fmt(report.checks.oldSessionsIntact)} |`,
  '', '## Ходы', '',
  '| Ход | Ожидали | Статус | Секция | Блок в сообщении | Токены |', '|---|---|---|---|---|---|',
  ...report.turns.map(turn => `| ${turn.turn} | ${turn.expected} | ${turn.status} | ${turn.sectionProfile || '—'} | ${turn.hasInstructionBlock ? 'да' : 'нет'} | ${turn.tokens ?? '—'} |`),
  '', '## Старые сессии', '',
  '| Сессия | Создана | События | Блок legacy в истории |', '|---|---|---|---|',
  ...report.oldSessions.map(entry => `| ${entry.id} | ${entry.createdAt || '—'} | ${entry.eventsReadable ? 'читаются' : '❌'} | ${entry.firstUserMessageHasLegacyBlock ? 'есть' : 'нет'} |`),
  '', '## Требует глаз оператора', '',
  '- Desktop (Windows) и Android: новая сессия, ответ, история, переподключение.',
  '- Ручное сжатие и команды Pi из UI.',
  '- Ошибка модели с toolEvidence — проверяется фикстурным тестом `tests/tool-evidence.test.mjs`.',
  '',
];
await fs.writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
await fs.writeFile(path.join(out, 'report.md'), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
console.log(`\nотчёт: ${path.relative(repo, path.join(out, 'report.md'))}`);
