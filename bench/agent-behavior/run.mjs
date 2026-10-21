#!/usr/bin/env node
// A/B-бенчмарк поведения агента (§ MR-05).
//
// Что делает: поднимает TaskBridge из указанного дерева кода (worktree) в
// изолированном каталоге данных, прогоняет сценарии из scenarios.json на
// синтетическом каталоге Learning, складывает ФАКТЫ прогона (вызовы, выводы,
// ответ, токены, время) в runs/*.json. Оценку делает evaluate.mjs — отдельно,
// чтобы её можно было проверять без моделей.
//
// Важно: A и B должны идти на одном коде-хосте, одной модели и одних настройках.
// Отличие вариантов — только дерево кода: A = коммит до PromptBuilder, B = текущий.
//
//   node bench/agent-behavior/run.mjs --variant B --out .local/bench/2026-10-21/B
//   node bench/agent-behavior/run.mjs --variant A --repo ../tb-before --out .local/bench/2026-10-21/A
//   node bench/agent-behavior/run.mjs --dry-run
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildFixture, DEFAULT_BULK } from './fixtures/build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scenarios = JSON.parse(await fs.readFile(path.join(here, 'scenarios.json'), 'utf8'));

function parseArgs(argv) {
  const args = { variant: 'B', repo: path.resolve(here, '..', '..'), timeoutMs: 180000, concurrency: 1, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--variant') args.variant = String(next()).toUpperCase();
    else if (arg === '--repo') args.repo = path.resolve(next());
    else if (arg === '--out') args.out = path.resolve(next());
    else if (arg === '--model') args.model = String(next());
    else if (arg === '--only') args.only = String(next()).split(',').map(item => item.trim()).filter(Boolean);
    else if (arg === '--limit') args.limit = Number(next());
    else if (arg === '--timeout') args.timeoutMs = Number(next());
    else if (arg === '--bulk') args.bulk = Number(next());
    else if (arg === '--dry-run') args.dryRun = true;
    else throw new Error(`Неизвестный аргумент: ${arg}`);
  }
  if (!['A', 'B'].includes(args.variant)) throw new Error('--variant A|B');
  if (!args.out && !args.dryRun) throw new Error('нужен --out <каталог прогона>');
  return args;
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

async function http(base, pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) throw Object.assign(new Error(`${method} ${pathname} → ${response.status}: ${parsed?.error || text}`), { code: parsed?.code });
  return parsed;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Корень запуска: копия кода из worktree плюс свой config.json и свой data/.
 * Копируется только то, что нужно серверу: правка worktree не понадобится, а
 * конфиг оператора не будет прочитан случайно.
 */
export async function prepareRoot({ repo, out, projectPath, port }) {
  const root = path.join(out, 'root');
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(root, { recursive: true });
  for (const dir of ['src', 'web', 'pi-extension']) {
    await fs.cp(path.join(repo, dir), path.join(root, dir), { recursive: true });
  }
  await fs.copyFile(path.join(repo, 'package.json'), path.join(root, 'package.json'));
  const config = {
    server: { host: '127.0.0.1', port, auth: { enabled: false } },
    pi: { command: 'pi', args: [], persistSessions: true, projectTrust: 'approve', mcp: { mode: 'off' } },
    localRuntime: {},
    projects: [{ id: 'bench', name: 'Bench', path: projectPath, useWorktree: false }],
  };
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config, null, 2));
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  return root;
}

export async function startServer(root, { port }) {
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TASKBRIDGE_DATA_DIR: path.join(root, 'data'), TASKBRIDGE_DISABLE_TLS: '1', TASKBRIDGE_PORT: String(port), TASKBRIDGE_BIND_HOST: '127.0.0.1', TASKBRIDGE_PUBLIC_PORT: String(port) },
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 600; i += 1) {
    if (child.exitCode != null) throw new Error(`сервер завершился: ${log.slice(-2000)}`);
    try {
      await http(base, '/api/info');
      return { child, base, log: () => log };
    } catch { await sleep(100); }
  }
  throw new Error(`сервер не поднялся: ${log.slice(-2000)}`);
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
}

const TOOL_LOG_CHARS = 4000;

/** Факты одного прогона: то, что потом оценивается без модели. */
export async function collectRun({ api, base, root, taskId, variant, scenarioId, startedAt, endedAt }) {
  const task = await api(base, `/api/tasks/${taskId}`);
  const artifactDir = path.join(root, 'data', 'tasks', taskId, 'artifacts');
  const eventsFile = path.join(artifactDir, 'pi-events.jsonl');
  const frames = (await fs.readFile(eventsFile, 'utf8').catch(() => ''))
    .split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);

  let prompt = '';
  const calls = [];
  for (const frame of frames) {
    if (frame.type === 'message_end' && frame.message?.role === 'user' && !prompt) prompt = textOf(frame.message);
    if (frame.type === 'tool_execution_start') {
      const args = frame.args || {};
      calls.push({
        toolCallId: frame.toolCallId || null,
        toolName: frame.toolName || 'tool',
        target: String(args.command || args.path || args.file_path || args.pattern || '').split('\n')[0].slice(0, 200),
        isError: false,
        output: '',
      });
    }
    if (frame.type === 'tool_execution_end' && frame.toolCallId) {
      const call = [...calls].reverse().find(item => item.toolCallId === frame.toolCallId);
      if (call) call.isError = frame.isError === true;
    }
  }
  // Выводы лежат не в журнале событий (result вырезан ради размера), а в tool-*.log.
  for (const call of calls) {
    if (!call.toolCallId) continue;
    const file = path.join(artifactDir, `tool-${call.toolCallId}.log`);
    call.output = (await fs.readFile(file, 'utf8').catch(() => '')).slice(0, TOOL_LOG_CHARS);
  }

  return {
    scenarioId,
    variant,
    model: task.model ? `${task.model.provider}/${task.model.id}` : null,
    status: task.status,
    errorCode: task.errorCode ?? null,
    startedAt,
    endedAt,
    elapsedMs: endedAt - startedAt,
    totalTokens: task.lastUsage?.totalTokens ?? null,
    prompt,
    answer: textOf({ content: task.assistantText }) || task.assistantText || '',
    toolCalls: calls,
  };
}

async function runScenario({ api, base, root, scenario, variant, args }) {
  const startedAt = Date.now();
  const created = await api(base, '/api/tasks', {
    method: 'POST',
    body: {
      projectId: 'bench',
      prompt: scenario.prompt,
      ...(args.model ? { model: { provider: args.model.split('/')[0], id: args.model.split('/')[1] } } : {}),
    },
  });
  let task = created;
  while (Date.now() - startedAt < args.timeoutMs) {
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) break;
    await sleep(250);
    task = await api(base, `/api/tasks/${created.id}`);
  }
  const endedAt = Date.now();
  return collectRun({ api, base, root, taskId: created.id, variant, scenarioId: scenario.id, startedAt, endedAt });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selected = scenarios.scenarios
    .filter(item => !args.only || args.only.includes(item.id))
    .slice(0, args.limit || undefined);

  if (args.dryRun) {
    console.log(`План: ${selected.length} сценариев × 1 вариант (${args.variant}) = ${selected.length} запусков`);
    for (const item of selected) console.log(`  ${item.id.padEnd(24)} ${item.category.padEnd(16)} ${item.expect.profile || '—'}`);
    return;
  }

  const out = args.out;
  await fs.mkdir(out, { recursive: true });
  const fixtureDir = path.join(out, 'fixture');
  await buildFixture(fixtureDir, { bulkFiles: args.bulk || DEFAULT_BULK });
  const port = await freePort();
  const root = await prepareRoot({ repo: args.repo, out, projectPath: fixtureDir, port });
  const server = await startServer(root, { port });
  const runsDir = path.join(out, 'runs');
  await fs.mkdir(runsDir, { recursive: true });

  const meta = {
    variant: args.variant,
    repo: args.repo,
    model: args.model || null,
    commit: await fs.readFile(path.join(root, 'data', 'build.json'), 'utf8').catch(() => null),
    startedAt: new Date().toISOString(),
    scenarios: selected.length,
  };
  console.log(`[${args.variant}] ${server.base} → ${runsDir}`);

  try {
    for (const scenario of selected) {
      const started = Date.now();
      try {
        const run = await runScenario({ api: http, base: server.base, root, scenario, variant: args.variant, args });
        await fs.writeFile(path.join(runsDir, `${args.variant}-${scenario.id}.json`), `${JSON.stringify(run, null, 2)}\n`);
        console.log(`  ${scenario.id.padEnd(24)} ${String(run.status).padEnd(10)} вызовов: ${String(run.toolCalls.length).padStart(2)}  ${Math.round((Date.now() - started) / 100) / 10}s`);
      } catch (error) {
        console.error(`  ${scenario.id}: ${error.message}`);
        await fs.writeFile(path.join(runsDir, `${args.variant}-${scenario.id}.json`), `${JSON.stringify({ scenarioId: scenario.id, variant: args.variant, status: 'ERROR', error: error.message }, null, 2)}\n`);
      }
    }
  } finally {
    server.child.kill();
    await fs.writeFile(path.join(out, 'meta.json'), `${JSON.stringify({ ...meta, finishedAt: new Date().toISOString() }, null, 2)}\n`);
    await fs.writeFile(path.join(out, 'server.log'), server.log()).catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
