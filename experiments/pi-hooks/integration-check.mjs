#!/usr/bin/env node
// Интеграционная проверка CORE-02: TaskBridge с режимом инструкций `legacy` или
// `hook`. Поднимает сервер из копии дерева в изолированном каталоге данных
// (операторские data/, config.json и agent-dir не затрагиваются) и прогоняет
// цепочку ходов, включая смену профиля.
//
//   node experiments/pi-hooks/integration-check.mjs --mode hook  --model deepseek/deepseek-flash
//   node experiments/pi-hooks/integration-check.mjs --mode legacy --model deepseek/deepseek-flash
//
// Что фиксируется по каждому ходу: что реально ушло в Pi (pi-events), есть ли
// системная секция turn_instructions и с каким профилем, системный промпт Pi
// (размер), токены хода и время. Отчёт — <out>/report.json.
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildFixture } from '../../bench/agent-behavior/fixtures/build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

function parseArgs(argv) {
  const args = { mode: 'hook', model: null, turns: null, timeoutMs: 180000, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[++i];
    if (argv[i] === '--mode') args.mode = String(next());
    else if (argv[i] === '--model') args.model = String(next());
    else if (argv[i] === '--out') args.out = path.resolve(String(next()));
    else if (argv[i] === '--timeout') args.timeoutMs = Number(next());
    // Каталог агента оператора (с его models.json и расширениями). Нужен для
    // провайдеров, которых нет в ядре Pi: `strata` объявлен в models.json
    // операторского agent-dir, поэтому изолированный каталог его не видит.
    else if (argv[i] === '--operator-agent-dir') args.operatorAgentDir = true;
    else throw new Error(`Неизвестный аргумент: ${argv[i]}`);
  }
  if (!['legacy', 'hook'].includes(args.mode)) throw new Error('--mode legacy|hook');
  args.out = args.out || path.join(repo, '.local', 'core02', `${args.mode}-${Date.now()}`);
  return args;
}

// Цепочка из пяти ходов: смена профиля и разные типы задач (Q → D → Q → E → Q).
const CHAIN = [
  { profile: 'quick', text: 'Есть ли в Learning курс Unreal Engine For Filmmakers? Посмотри.' },
  { profile: 'implement', text: 'Исправь опечатку в файле README.md в рабочей папке.' },
  { profile: 'quick', text: 'А теперь просто посмотри, есть ли папка Houdini в Learning.' },
  { profile: 'explore', text: 'Разберись, чем отличаются Chapter 01 и Chapter 02 в курсе Unreal Engine For Filmmakers.' },
  { profile: 'quick', text: 'Есть ли файл Links.txt в папке Green Screen?' },
];

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const http = async (base, pathname, { method = 'GET', body } = {}) => {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) throw Object.assign(new Error(`${method} ${pathname} → ${response.status}: ${parsed?.error || text}`), { code: parsed?.code });
  return parsed;
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const args = parseArgs(process.argv.slice(2));
await fs.mkdir(args.out, { recursive: true });
const fixtureDir = path.join(args.out, 'fixture');
await buildFixture(fixtureDir, { bulkFiles: 100 });
// README.md — для сценария «исправь опечатку».
await fs.writeFile(path.join(fixtureDir, 'README.md'), '# Learning\n\nкурс: Unreal Engine For Filmakers\n');

const root = path.join(args.out, 'root');
await fs.rm(root, { recursive: true, force: true }).catch(() => {});
await fs.mkdir(root, { recursive: true });
for (const dir of ['src', 'web', 'pi-extension']) await fs.cp(path.join(repo, dir), path.join(root, dir), { recursive: true });
await fs.copyFile(path.join(repo, 'package.json'), path.join(root, 'package.json'));
const port = await freePort();
await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({
  server: { host: '127.0.0.1', port, auth: { enabled: false } },
  // `mcp.mode: 'inherit'` — не управлять MCP из TaskBridge. Это же обязательно
  // для изолированного agent-dir: флаг `--mcp-config`, который TaskBridge
  // передаёт в managed/off, регистрирует MCP-расширение оператора, а не ядро Pi;
  // без расширения Pi отвечает «Unknown option: --mcp-config» и не стартует.
  pi: { command: 'pi', args: [], projectTrust: 'approve', mcp: { mode: 'inherit' }, turnInstructions: { mode: args.mode } },
  localRuntime: {},
  projects: [{ id: 'bench', name: 'Bench', path: fixtureDir, useWorktree: false }],
}, null, 2));

// Изолированный agent-dir: глобальные расширения и настройки оператора не
// участвуют, иначе «hook» проверялся бы вместе с чужими хуками.
const agentDir = path.join(args.out, 'pi-agent');
if (!args.operatorAgentDir) {
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 20000 } }, null, 2));
}

const child = spawn(process.execPath, ['src/server.mjs'], {
  cwd: root,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    TASKBRIDGE_DATA_DIR: path.join(root, 'data'),
    ...(args.operatorAgentDir ? {} : { PI_CODING_AGENT_DIR: agentDir }),
    TASKBRIDGE_DISABLE_TLS: '1',
    TASKBRIDGE_PORT: String(port),
    TASKBRIDGE_BIND_HOST: '127.0.0.1',
    TASKBRIDGE_PUBLIC_PORT: String(port),
  },
});
let log = '';
child.stdout.on('data', chunk => { log += chunk; });
child.stderr.on('data', chunk => { log += chunk; });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 600; i += 1) {
  if (child.exitCode != null) throw new Error(`сервер завершился: ${log.slice(-1500)}`);
  try { await http(base, '/api/info'); break; } catch { await sleep(100); }
}

const terminal = async id => {
  const started = Date.now();
  let task = await http(base, `/api/tasks/${id}`);
  while (Date.now() - started < args.timeoutMs) {
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return task;
    await sleep(300);
    task = await http(base, `/api/tasks/${id}`);
  }
  return task;
};

const readJsonl = async file => (await fs.readFile(file, 'utf8').catch(() => ''))
  .split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);

/** Что ушло в Pi в этом ходе и что записано в транскрипте сессии. */
const turnFacts = async (taskId, fromOffset) => {
  const artifactDir = path.join(root, 'data', 'tasks', taskId, 'artifacts');
  const frames = await readJsonl(path.join(artifactDir, 'pi-events.jsonl'));
  const users = frames.filter(frame => frame.type === 'message_end' && frame.message?.role === 'user')
    .map(frame => (Array.isArray(frame.message.content)
      ? frame.message.content.filter(part => part.type === 'text').map(part => part.text).join('')
      : String(frame.message.content || '')));
  const sessionsDir = path.join(root, 'data', 'pi-sessions', taskId);
  const files = (await fs.readdir(sessionsDir).catch(() => [])).filter(name => name.endsWith('.jsonl')).sort();
  const entries = files.length ? await readJsonl(path.join(sessionsDir, files.at(-1))) : [];
  const patches = entries.filter(entry => entry.type === 'message' && entry.message?.sections
    && Object.prototype.hasOwnProperty.call(entry.message.sections, 'turn_instructions'));
  return {
    deliveredPrompt: users.at(-1) || null,
    deliveredCount: users.length,
    instructionsInMessage: /Task instructions \(\w+\)/.test(users.at(-1) || ''),
    sectionPatches: patches.length,
    sectionProfile: patches.map(entry => /Task instructions \((\w+)\)/.exec(String(entry.message.sections.turn_instructions || ''))?.[1] || null).filter(Boolean).at(-1) || null,
    sectionChars: patches.map(entry => String(entry.message.sections.turn_instructions || '').length).at(-1) || null,
  };
};

const report = { at: new Date().toISOString(), mode: args.mode, model: args.model || '(default)', operatorAgentDir: Boolean(args.operatorAgentDir), port, turns: [] };
try {
  const created = await http(base, '/api/tasks', {
    method: 'POST',
    body: {
      projectId: 'bench',
      prompt: CHAIN[0].text,
      ...(args.model ? { model: { provider: args.model.split('/')[0], id: args.model.split('/')[1] } } : {}),
    },
  });
  let task = await terminal(created.id);
  let facts = await turnFacts(created.id);
  report.turns.push({ turn: 1, expected: CHAIN[0].profile, status: task.status, tokens: task.lastUsage?.totalTokens ?? null, ...facts });
  for (const [index, step] of CHAIN.slice(1).entries()) {
    const sentAt = Date.now();
    const before = facts.sectionPatches;
    await http(base, `/api/tasks/${created.id}/message`, { method: 'POST', body: { text: step.text } });
    task = await terminal(created.id);
    facts = await turnFacts(created.id);
    report.turns.push({
      turn: index + 2,
      expected: step.profile,
      status: task.status,
      ms: Date.now() - sentAt,
      tokens: task.lastUsage?.totalTokens ?? null,
      newSectionPatch: facts.sectionPatches > before,
      ...facts,
    });
  }
  report.summary = {
    messageHasInstructions: report.turns.filter(turn => turn.instructionsInMessage).length,
    sectionProfiles: report.turns.map(turn => turn.sectionProfile),
    expectedProfiles: CHAIN.map(step => step.profile),
    lastTokens: report.turns.at(-1).tokens,
    sectionChars: report.turns.map(turn => turn.sectionChars),
  };
} finally {
  child.kill();
  await fs.writeFile(path.join(args.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(args.out, 'server.log'), log);
}
console.log(JSON.stringify(report.summary, null, 2));
console.log(`отчёт: ${path.relative(repo, path.join(args.out, 'report.json'))}`);
