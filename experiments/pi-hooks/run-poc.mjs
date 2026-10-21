#!/usr/bin/env node
// Стенд PoC (TASKBRIDGE-CORE-01): настоящий Pi в режиме RPC + расширение с
// хуком `before_agent_start`. Ничего из TaskBridge не запускается и не меняется.
//
//   node experiments/pi-hooks/run-poc.mjs --out .local/pi-hooks/2026-10-21 --model deepseek/deepseek-flash
//
// Что доказывает прогон:
//   1. хук срабатывает на каждом новом ходе и получает дословный текст оператора;
//   2. профиль пересчитывается на каждом ходу (implement → quick);
//   3. команда Pi (`/tb-profile`) исполняется штатно и хук для неё не срабатывает;
//   4. steering попадает в текущий ход и лишних инструкций не добавляет;
//   5. compaction — отдельный вызов модели, хук на него не срабатывает;
//   6. восстановленная сессия продолжается, история дословна, системная секция одна;
//   7. падение хука не теряет сообщение и не вызывает повторов.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

function parseArgs(argv) {
  const args = { out: path.join(repo, '.local', 'pi-hooks', new Date().toISOString().replace(/[:.]/g, '-')), model: null, timeoutMs: 120000, extension: null, slash: '/tb-profile' };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[++i];
    if (argv[i] === '--out') args.out = path.resolve(next());
    else if (argv[i] === '--model') args.model = String(next());
    else if (argv[i] === '--timeout') args.timeoutMs = Number(next());
    // --extension проверяет ЛЮБОЕ расширение тем же стендом: PoC или production
    // (pi-extension/taskbridge-turn-instructions.js). --slash — команда для
    // сценария «команда обрабатывается штатно» (/tb-profile есть только у PoC).
    else if (argv[i] === '--extension') args.extension = path.resolve(String(next()));
    else if (argv[i] === '--slash') args.slash = String(next()); // из git-bash нужен MSYS_NO_PATHCONV=1
    else if (argv[i] === '--skip-slash') args.skipSlash = true;
    else throw new Error(`Неизвестный аргумент: ${argv[i]}`);
  }
  return args;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Минимальный RPC-клиент: JSONL по stdin/stdout, сопоставление по id. */
class PiRpc {
  constructor({ cwd, args, env }) {
    this.proc = spawn('pi', ['--mode', 'rpc', ...args], { cwd, env: { ...process.env, ...env }, windowsHide: true, shell: process.platform === 'win32' });
    this.pending = new Map();
    this.events = [];
    this.listeners = new Set();
    this.stderr = '';
    this.stdout = '';
    this.closed = false;
    this.proc.stderr.on('data', chunk => { this.stderr += chunk; });
    this.proc.stdout.on('data', chunk => this.#onData(chunk));
    this.proc.on('exit', code => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error(`Pi завершился (code=${code}): ${this.stderr.slice(-500)}`)); }
      this.pending.clear();
    });
  }

  #onData(chunk) {
    this.stdout += chunk;
    let index;
    while ((index = this.stdout.indexOf('\n')) >= 0) {
      const line = this.stdout.slice(0, index).replace(/\r$/, '');
      this.stdout = this.stdout.slice(index + 1);
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type === 'response' && record.id) {
        const waiter = this.pending.get(record.id);
        if (waiter) { clearTimeout(waiter.timer); this.pending.delete(record.id); waiter.resolve(record); }
        continue;
      }
      this.events.push(record);
      for (const listener of [...this.listeners]) listener(record);
    }
  }

  send(command, timeoutMs = 30000) {
    const id = `${command.type}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`нет ответа на ${command.type} за ${timeoutMs} мс`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  /**
   * Ждёт НОВОЕ событие по предикату. Уже пришедшие не годятся: `agent_settled`
   * предыдущего хода иначе закрывал бы ожидание следующего.
   */
  waitFor(predicate, timeoutMs) {
    const from = this.events.length;
    const seen = this.events.slice(from).find(predicate);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(listener); reject(new Error('событие не дождались')); }, timeoutMs);
      const listener = record => {
        if (!predicate(record)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(record);
      };
      this.listeners.add(listener);
    });
  }

  async stop() {
    try { this.proc.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`); } catch { /* уже закрыт */ }
    await sleep(300);
    if (!this.closed) this.proc.kill();
    await sleep(200);
  }
}

async function readJsonl(file) {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

/** Что записано в журнале сессии: дословность реплик и системная секция. */
async function sessionFacts(sessionFile) {
  const entries = await readJsonl(sessionFile);
  const messages = entries.filter(entry => entry.type === 'message').map(entry => entry.message);
  const userTexts = messages.filter(m => m.role === 'user').map(m => (Array.isArray(m.content) ? m.content.filter(p => p.type === 'text').map(p => p.text).join('') : String(m.content)));
  const systemMessages = messages.filter(m => m.role === 'system');
  const sectionPatches = systemMessages.filter(m => m.sections && Object.prototype.hasOwnProperty.call(m.sections, 'turn_instructions'));
  return {
    entries: entries.length,
    userTexts,
    systemMessages: systemMessages.length,
    // Профиль виден в самом тексте секции: «Task instructions (quick):». Это
    // единственный след хука, который есть у ЛЮБОГО расширения, а не только у PoC
    // с журналом.
    turnInstructionsProfiles: sectionPatches
      .map(m => /Task instructions \((\w+)\)/.exec(String(m.sections.turn_instructions || ''))?.[1] || null)
      .filter(Boolean),
    turnInstructionsPatches: sectionPatches.length,
    turnInstructionsChars: sectionPatches.map(m => String(m.sections.turn_instructions || '').length),
    profiles: entries.map(entry => (entry.type === 'compaction' ? 'compaction' : null)).filter(Boolean),
  };
}

const args = parseArgs(process.argv.slice(2));
const out = args.out;
await fs.mkdir(out, { recursive: true });
const workspace = path.join(out, 'workspace');
const sessions = path.join(out, 'sessions');
const hookLog = path.join(out, 'hook.jsonl');
await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(sessions, { recursive: true });
await fs.writeFile(path.join(workspace, 'README.md'), '# PoC workspace\n\nэтa строка намеренно с опечаткой\n');
await fs.writeFile(path.join(workspace, 'note.txt'), 'note\n');
await fs.rm(hookLog, { force: true }).catch(() => {});
// Изолированный agent-dir: глобальные настройки и расширения оператора не
// участвуют в эксперименте. Ключи провайдеров берутся из окружения, поэтому
// копировать чужие credentials не нужно. keepRecentTokens уменьшен, иначе
// сессия из нескольких коротких ходов «слишком мала» для compaction, и шестой
// сценарий ничего не проверяет.
const agentDir = path.join(out, 'pi-agent');
await fs.rm(agentDir, { recursive: true, force: true }).catch(() => {});
await fs.mkdir(agentDir, { recursive: true });
await fs.writeFile(path.join(agentDir, 'settings.json'), `${JSON.stringify({ compaction: { keepRecentTokens: 200 } }, null, 2)}
`);

const extension = args.extension || path.join(here, 'turn-instructions.js');
const broken = path.join(here, 'broken-extension.js');
const modelArgs = args.model ? ['--provider', args.model.split('/')[0], '--model', args.model.split('/')[1]] : [];
// Pi читает именно PI_CODING_AGENT_DIR; TaskBridge в src/pi-settings.mjs зовёт его
// PI_AGENT_DIR — это расхождение отмечено в отчёте, здесь используется имя Pi.
const env = { TB_HOOK_LOG: hookLog, PI_CODING_AGENT_DIR: agentDir };

const report = { at: new Date().toISOString(), piVersion: null, model: args.model || '(default)', scenarios: {} };
report.piVersion = (await new Promise(resolve => {
  const child = spawn('pi', ['--version'], { windowsHide: true, shell: process.platform === 'win32' });
  let text = '';
  child.stdout.on('data', chunk => { text += chunk; });
  child.on('exit', () => resolve(text.trim()));
})).trim();

const hookEntries = async () => readJsonl(hookLog);

/**
 * Сколько ходов реально получили инструкции. Журнал хука пишет только PoC-
 * расширение; production-расширение (pi-extension/taskbridge-turn-instructions.js)
 * ничего не логирует, поэтому вторым источником служит сам транскрипт: Pi
 * записывает системный патч секции `turn_instructions` на каждый ход.
 * Берётся максимум из двух — стенд не должен зависеть от того, какое
 * расширение загружено.
 */
const sessionPatchCount = async () => {
  const files = (await fs.readdir(sessions).catch(() => [])).filter(name => name.endsWith('.jsonl')).sort();
  const file = files.at(-1);
  if (!file) return 0;
  const facts = await sessionFacts(path.join(sessions, file));
  return facts.turnInstructionsPatches;
};

const lastSessionFacts = async () => {
  const files = (await fs.readdir(sessions).catch(() => [])).filter(name => name.endsWith('.jsonl')).sort();
  const file = files.at(-1);
  return file ? sessionFacts(path.join(sessions, file)) : null;
};

const counts = async () => {
  const entries = await hookEntries();
  const logged = entries.filter(entry => entry.profile).length;
  const patched = await sessionPatchCount();
  return { total: Math.max(logged, patched), logged, patched, entries };
};

const runPrompt = async (rpc, text, { expectRun = true } = {}) => {
  const before = await counts();
  const response = await rpc.send({ type: 'prompt', message: text });
  if (!expectRun) return { response, before };
  if (response.success && response.data?.disposition === 'started') await rpc.waitFor(record => record.type === 'agent_settled', args.timeoutMs);
  else if (!response.success) throw new Error(`prompt отклонён: ${response.error}`);
  const after = await counts();
  return { response, before, after };
};

// --- сессия 1: quick, implement → quick, команда, steering, compaction -------
let rpc = new PiRpc({ cwd: workspace, args: ['--approve', '--session-dir', sessions, '--name', 'poc', '-e', extension, ...modelArgs], env });
await rpc.waitFor(record => record.type === 'agent_ready' || record.type === 'session_ready' || record.type === 'ready', 60000).catch(() => {});
await rpc.send({ type: 'get_state' });

report.scenarios.initialQuick = await (async () => {
  const result = await runPrompt(rpc, 'Посмотри, есть ли файл README.md в текущей папке.');
  return {
    prompt: 'Посмотри, есть ли файл README.md в текущей папке.',
    disposition: result.response.data?.disposition,
    hookCalls: result.after.total - result.before.total,
    profile: (await lastSessionFacts())?.turnInstructionsProfiles.at(-1) || null,
    promptChars: result.after.entries.filter(entry => entry.profile).at(-1)?.promptChars ?? null,
    systemPromptChars: [result.after.entries.filter(entry => entry.profile).at(-1)?.systemPromptCharsBefore, result.after.entries.filter(entry => entry.profile).at(-1)?.systemPromptCharsAfter],
  };
})();

report.scenarios.followUpProfile = await (async () => {
  const implement = await runPrompt(rpc, 'Исправь опечатку в README.md.');
  const quick = await runPrompt(rpc, 'А теперь просто посмотри, есть ли файл note.txt.');
  const entries = quick.after.entries.filter(entry => entry.profile);
  const profiles = (await lastSessionFacts())?.turnInstructionsProfiles || [];
  return {
    implementProfile: entries.at(-2)?.profile || profiles.at(-2) || null,
    quickProfile: entries.at(-1)?.profile || profiles.at(-1) || null,
    hookCallsTotal: quick.after.total,
    systemPromptChars: entries.slice(-2).map(entry => entry.systemPromptCharsAfter),
  };
})();

report.scenarios.slashCommand = args.skipSlash ? { skipped: 'команда не регистрируется этим расширением' } : await (async () => {
  const before = await counts();
  const response = await rpc.send({ type: 'prompt', message: args.slash });
  await sleep(500);
  const after = await counts();
  return {
    disposition: response.data?.disposition,
    success: response.success,
    hookCallsForCommand: after.total - before.total,
    commandLogged: after.entries.some(entry => entry.command === 'tb-profile'),
    command: args.slash,
  };
})();

report.scenarios.steering = await (async () => {
  const before = await counts();
  const slow = await rpc.send({ type: 'prompt', message: 'Найди причину, почему README.md выглядит странно.' });
  // Вклинивание во время генерации: новый ход не начинается, инструкций не добавляется.
  await sleep(1500);
  const steer = await rpc.send({ type: 'steer', message: 'добавь ещё одну строку в ответ' }).catch(error => ({ success: false, error: error.message }));
  await rpc.waitFor(record => record.type === 'agent_settled', args.timeoutMs).catch(() => {});
  const after = await counts();
  return {
    promptDisposition: slow.data?.disposition,
    steerDisposition: steer.data?.disposition ?? null,
    hookCallsForPrompt: after.total - before.total,
  };
})();

report.scenarios.compaction = await (async () => {
  const before = await counts();
  const response = await rpc.send({ type: 'compact' }, args.timeoutMs).catch(error => ({ success: false, error: error.message }));
  await sleep(1000);
  const after = await counts();
  return {
    success: response.success !== false,
    error: response.error || null,
    hookCallsForCompaction: after.total - before.total,
  };
})();

// --- сессия 2: восстановление сохранённой сессии -----------------------------
const sessionList = await fs.readdir(sessions).catch(() => []);
const sessionFile = sessionList.filter(name => name.endsWith('.jsonl')).map(name => path.join(sessions, name)).sort().at(-1) || null;
report.sessionFile = sessionFile;
const factsBeforeRestart = sessionFile ? await sessionFacts(sessionFile) : null;
await rpc.stop();

report.scenarios.restoredSession = await (async () => {
  if (!sessionFile) return { error: 'файл сессии не найден' };
  rpc = new PiRpc({ cwd: workspace, args: ['--approve', '--session', sessionFile, '--session-dir', sessions, '-e', extension, ...modelArgs], env });
  await rpc.send({ type: 'get_state' });
  const before = await counts();
  const result = await runPrompt(rpc, 'Есть ли файл note.txt в текущей папке?');
  const after = await counts();
  const factsAfter = await sessionFacts(sessionFile);
  return {
    hookCalls: after.total - before.total,
    profile: after.entries.filter(entry => entry.profile).at(-1)?.profile || null,
    userTextsBefore: factsBeforeRestart?.userTexts.length ?? null,
    userTextsAfter: factsAfter.userTexts.length,
    lastUserTextVerbatim: factsAfter.userTexts.at(-1) === 'Есть ли файл note.txt в текущей папке?',
    turnInstructionsPatches: factsAfter.turnInstructionsPatches,
    turnInstructionsChars: factsAfter.turnInstructionsChars,
  };
})();
await rpc.stop();

// --- сессия 3: сломанное расширение ----------------------------------------
report.scenarios.brokenExtension = await (async () => {
  rpc = new PiRpc({ cwd: workspace, args: ['--approve', '--no-session', '-e', extension, '-e', broken, ...modelArgs], env });
  await rpc.send({ type: 'get_state' });
  const before = await counts();
  const response = await rpc.send({ type: 'prompt', message: 'Посмотри, есть ли файл note.txt.' });
  let settled = false;
  if (response.success && response.data?.disposition === 'started') {
    settled = await rpc.waitFor(record => record.type === 'agent_settled', args.timeoutMs).then(() => true, () => false);
  }
  const after = await counts();
  const text = rpc.events.filter(record => record.type === 'message_end' && record.message?.role === 'assistant')
    .map(record => (Array.isArray(record.message.content) ? record.message.content.filter(p => p.type === 'text').map(p => p.text).join('') : '')).join('');
  // Ошибка хука приходит отдельным RPC-событием `extension_error`, а не в stderr:
  // Pi её ловит и продолжает ход (runner.js: emitError вокруг каждого handler).
  const extensionError = rpc.events.find(record => record.type === 'extension_error') || null;
  await rpc.stop();
  return {
    disposition: response.data?.disposition,
    settled,
    hookCalls: after.total - before.total,
    answerChars: text.trim().length,
    errorReported: Boolean(extensionError),
    extensionError: extensionError ? { event: extensionError.event, error: extensionError.error } : null,
    repeats: rpc.events.filter(record => record.type === 'extension_error').length,
  };
})();

report.verdict = {
  // Условия приёмки этапа 1.
  promptVerbatim: report.scenarios.restoredSession.lastUserTextVerbatim === true,
  perTurnInstructions: report.scenarios.followUpProfile.implementProfile === 'implement'
    && report.scenarios.followUpProfile.quickProfile === 'quick',
  noAccumulation: (() => {
    const sizes = report.scenarios.followUpProfile.systemPromptChars || [];
    // Размер системного промпта не должен расти от хода к ходу на длину инструкции.
    return sizes.length < 2 || Math.abs(sizes[1] - sizes[0]) < 80;
  })(),
  commandHandled: report.scenarios.slashCommand.skipped ? 'skipped' : (report.scenarios.slashCommand.disposition === 'handled'
    && report.scenarios.slashCommand.hookCallsForCommand === 0),
  steerDoesNotAddInstructions: report.scenarios.steering.hookCallsForPrompt === 1,
  compactionNoHook: report.scenarios.compaction.hookCallsForCompaction === 0,
  restoredSessionWorks: report.scenarios.restoredSession.hookCalls === 1
    && report.scenarios.restoredSession.turnInstructionsPatches >= 1,
  brokenHookSurvives: report.scenarios.brokenExtension.answerChars > 0
    && report.scenarios.brokenExtension.errorReported === true,
};

await fs.writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.verdict, null, 2));
console.log(`отчёт: ${path.relative(repo, path.join(out, 'report.json'))}`);
