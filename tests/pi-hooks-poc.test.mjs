// PoC (TASKBRIDGE-CORE-01): проверка самого расширения без Pi и без модели.
//
// Здесь проверяется то, что можно проверить детерминированно: фабрика
// регистрирует обработчик `before_agent_start` и команду, обработчик берёт
// ДОСЛОВНЫЙ prompt, перезаписывает одну именованную секцию (а не дописывает) и
// не трогает ходы, начатые НЕ оператором (`messageType: 'custom'`).
// Поведение внутри настоящего Pi проверяется стендом experiments/pi-hooks/run-poc.mjs,
// здесь модели нет по построению.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { instructionsFor } from '../experiments/pi-hooks/turn-instructions.js';
import turnInstructions from '../experiments/pi-hooks/turn-instructions.js';
import brokenExtension from '../experiments/pi-hooks/broken-extension.js';

/** Минимальный стенд Pi: только то, что использует PoC. */
function fakePi() {
  const handlers = new Map();
  const commands = new Map();
  const pi = {
    on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event); },
    registerCommand(name, options) { commands.set(name, options); },
  };
  return { pi, handlers, commands };
}

const startEvent = (prompt, { messageType = 'user', sections = {} } = {}) => {
  const options = { sections: { ...sections }, selectedTools: ['read', 'bash'], promptGuidelines: [] };
  return {
    type: 'before_agent_start',
    messageType,
    prompt,
    systemPromptOptions: options,
    get systemPrompt() { return `base:${JSON.stringify(options.sections).length}`; },
  };
};

const withLog = async (t, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-hook-'));
  const log = path.join(dir, 'hook.jsonl');
  const previous = process.env.TB_HOOK_LOG;
  process.env.TB_HOOK_LOG = log;
  t.after(() => {
    if (previous === undefined) delete process.env.TB_HOOK_LOG;
    else process.env.TB_HOOK_LOG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return fn(log);
};

const entries = log => fs.existsSync(log)
  ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  : [];

test('расширение регистрирует хук и команду', () => {
  const { pi, handlers, commands } = fakePi();
  turnInstructions(pi);
  assert.equal(typeof handlers.get('before_agent_start'), 'function');
  assert.ok(commands.has('tb-profile'), 'команда нужна для проверки «команда обрабатывается штатно»');
});

test('инструкции зависят от профиля и содержат общий контракт', () => {
  const quick = instructionsFor('quick');
  assert.match(quick, /^Task instructions \(quick\):/);
  assert.match(quick, /This is a lookup/);
  assert.match(quick, /keep what the earlier tools already confirmed/);
  assert.doesNotMatch(quick, /summarize what changed/);
  assert.match(instructionsFor('implement'), /summarize what changed and which checks ran/);
  assert.match(instructionsFor('explore'), /Investigation is allowed/);
  assert.match(instructionsFor('nonsense'), /Investigation is allowed/, 'неизвестный профиль — explore');
});

test('хук берёт дословный prompt и перезаписывает одну секцию', async t => {
  await withLog(t, async log => {
    const { pi, handlers } = fakePi();
    turnInstructions(pi);
    const handler = handlers.get('before_agent_start');

    const implement = startEvent('Исправь опечатку в README.md.');
    await handler(implement);
    assert.deepEqual(Object.keys(implement.systemPromptOptions.sections), ['turn_instructions']);
    const afterImplement = implement.systemPromptOptions.sections.turn_instructions;
    assert.match(afterImplement, /Task instructions \(implement\)/);

    const quick = startEvent('Посмотри, есть ли файл note.txt.');
    await handler(quick);
    assert.deepEqual(Object.keys(quick.systemPromptOptions.sections), ['turn_instructions'], 'секция одна, а не две');
    assert.match(quick.systemPromptOptions.sections.turn_instructions, /Task instructions \(quick\)/);
    assert.notEqual(quick.systemPromptOptions.sections.turn_instructions, afterImplement);

    const written = entries(log);
    assert.equal(written.length, 2);
    assert.equal(written[0].prompt, 'Исправь опечатку в README.md.', 'prompt записан дословно');
    assert.equal(written[1].profile, 'quick');
    assert.equal(written[1].prompt, 'Посмотри, есть ли файл note.txt.');
  });
});

test('чужой ход (custom message) не получает инструкций', async t => {
  await withLog(t, async log => {
    const { pi, handlers } = fakePi();
    turnInstructions(pi);
    const handler = handlers.get('before_agent_start');
    const custom = startEvent(undefined, { messageType: 'custom' });
    await handler(custom);
    assert.deepEqual(custom.systemPromptOptions.sections, {}, 'секции не тронуты');
    assert.equal(entries(log).at(-1).skipped, 'custom-message');
  });
});

test('сломанное расширение действительно падает — на этом строится сценарий 7', async () => {
  const { pi, handlers } = fakePi();
  brokenExtension(pi);
  await assert.rejects(() => handlers.get('before_agent_start')(startEvent('что угодно')), /намеренная ошибка/);
});
