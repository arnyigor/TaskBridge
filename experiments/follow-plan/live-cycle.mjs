#!/usr/bin/env node
// FP-06B: живой прогон Follow Plan на настоящем Pi и настоящей модели.
//
//   node experiments/follow-plan/live-cycle.mjs --model deepseek/deepseek-flash
//
// Стенд изолирован целиком: свой корень (src/web/pi-extension копируются),
// свой dataRoot, свой рабочий проект, свой каталог агента Pi. Рабочий TaskBridge,
// его config.json, его data и его Pi-сессии не читаются и не меняются.
//
// Ход событий: задача создаётся обычным сообщением, затем включается «По плану»
// (attach) и одним действием запускается цикл (start). Дальше TaskBridge сам
// отправляет следующий шаг; стенд только читает состояние и считает факты:
// сколько было настоящих Pi-prompts, Run, USER_MESSAGE, checkpoints и вызовов
// изменяющих инструментов.
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};

const model = argValue('--model', 'deepseek/deepseek-flash');
const [provider, modelId] = model.split('/');
const timeoutMs = Number(argValue('--timeout', '600000'));
const out = path.resolve(argValue('--out', path.join(repo, '.local', 'fp-06', `live-${Date.now()}`)));

const PLAN = `---
taskbridge_plan: 1
plan_id: p-live
revision: 1
goal: "Две небольшие функции с тестами"
---

# План: две функции с тестами

## Шаги

### S-001 | TODO | P1 | Функция суммы и её тест
**Критерии:** файл calc.mjs экспортирует add(a, b), тест в calc.test.mjs проходит.
**Проверка:** node --test calc.test.mjs

### S-002 | TODO | P1 | Функция разности и её тест
**Критерии:** calc.mjs экспортирует sub(a, b), оба теста проходят.
**Проверка:** node --test calc.test.mjs

## Обнаруженные проблемы
`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const freePort = async () => {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
};

await fs.mkdir(out, { recursive: true });
const root = path.join(out, 'app');
const dataDir = path.join(out, 'data');
const workspace = path.join(out, 'workspace');
const agentDir = path.join(out, 'pi-agent');
for (const dir of [root, dataDir, workspace, agentDir]) await fs.mkdir(dir, { recursive: true });
await fs.cp(path.join(repo, 'src'), path.join(root, 'src'), { recursive: true });
await fs.cp(path.join(repo, 'web'), path.join(root, 'web'), { recursive: true });
await fs.cp(path.join(repo, 'pi-extension'), path.join(root, 'pi-extension'), { recursive: true });
await fs.copyFile(path.join(repo, 'package.json'), path.join(root, 'package.json'));
await fs.writeFile(path.join(workspace, 'PLAN.md'), PLAN, 'utf8');
let port = await freePort();
const config = {
  server: { host: '127.0.0.1', port, auth: { enabled: false } },
  pi: { command: 'pi', projectTrust: 'approve', persistSessions: true, turnInstructions: { mode: 'legacy' } },
  projects: [{ id: 'fp06', name: 'FP-06 live', path: workspace, useWorktree: false }],
  followPlan: { enabled: true }
};
await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config, null, 2));

// The child gets an isolated agent dir and nothing that belongs to the operator's
// own TaskBridge run: a TASKBRIDGE_* variable inherited from the shell (this agent
// itself runs inside TaskBridge) once made the isolated server re-launch an orphan
// on the operator's port. Provider keys are kept: the model needs them.
const inherited = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !key.startsWith('PI_') && !key.startsWith('TASKBRIDGE_')));
let child = null;
let logs = '';
const launch = () => {
  logs = '';
  child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...inherited, PI_CODING_AGENT_DIR: agentDir, TASKBRIDGE_DATA_DIR: dataDir }
  });
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
};

let base = `http://127.0.0.1:${port}`;
const api = async (route, body, method) => {
  const response = await fetch(base + route, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!response.ok) throw Object.assign(new Error(`${response.status} ${data?.error || text}`), { code: data?.code, status: response.status });
  return data;
};

const stop = async () => {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).on('exit', resolve));
  } else child.kill('SIGTERM');
  await sleep(500);
};

const report = { at: new Date().toISOString(), piVersion: null, model, workspace, port, steps: [], counters: {}, result: null, plan: null, error: null };

try {
  // The ephemeral port can be taken between the probe and the bind: retry a few
  // times instead of failing the whole run on a port race.
  let ready = false;
  for (let attempt = 0; attempt < 4 && !ready; attempt++) {
    if (attempt) {
      port = await freePort();
      base = `http://127.0.0.1:${port}`;
      config.server.port = port;
      await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(config, null, 2));
    }
    launch();
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) break;
      try { await api('/api/health'); ready = true; break; } catch { await sleep(100); }
    }
    if (ready) break;
    await stop();
    if (!/EADDRINUSE/.test(logs)) break;
  }
  if (!ready) throw new Error(`server did not become ready: ${logs.slice(-1500)}`);
  // The version probe runs in the background at startup: read it once the cycle is
  // over, otherwise the field is legitimately still empty.

  // A session has to exist before a plan can be attached. This is the only manual
  // message: everything after `start` must come from the controller.
  const task = await api('/api/tasks', { projectId: 'fp06', prompt: 'Ответь одним словом: ок', model: { provider, id: modelId } });
  for (let i = 0; i < 300; i++) {
    const state = await api(`/api/tasks/${task.id}`);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(state.status)) {
      if (state.status !== 'SUCCEEDED') throw new Error(`setup turn ${state.status}: ${state.error || ''}`);
      break;
    }
    await sleep(500);
  }

  await api(`/api/tasks/${task.id}/plan/attach`, { path: 'PLAN.md', commandId: 'fp06-attach' });
  const started = await api(`/api/tasks/${task.id}/plan/start`, { expectedRevision: 1, commandId: 'fp06-start' });
  report.steps.push({ at: new Date().toISOString(), state: started.state, stepId: started.stepId });

  const deadline = Date.now() + timeoutMs;
  let status = started;
  const seen = new Set();
  while (Date.now() < deadline) {
    status = await api(`/api/tasks/${task.id}/plan`);
    const key = `${status.state}:${status.stepId}:${status.revision}`;
    if (!seen.has(key)) {
      seen.add(key);
      report.steps.push({ at: new Date().toISOString(), state: status.state, stepId: status.stepId, revision: status.revision, progress: status.progress });
    }
    if (['COMPLETED', 'PAUSED', 'PAUSED_REVIEW'].includes(status.state)) break;
    await sleep(1000);
  }
  report.result = status.state;
  report.plan = {
    revision: status.revision,
    progress: status.progress,
    goal: status.goal,
    steps: status.steps,
    findings: status.findings,
    lastCheckpoint: status.lastCheckpoint
  };

  // Facts, not impressions: what the run actually did.
  const info = await api('/api/info');
  report.piVersion = info?.pi?.version ?? null;
  report.piRange = info?.pi?.supportedRange ?? null;
  report.piSupported = info?.pi?.supported ?? null;
  const events = await api(`/api/tasks/${task.id}/events`);
  const typed = type => events.filter(event => event.type === type);
  const toolStarts = events.filter(event => event.type === 'PI_EVENT' && event.data?.pi?.type === 'tool_execution_start');
  const deliveries = (await fs.readFile(path.join(workspace, 'pi-deliveries.ndjson'), 'utf8').catch(() => ''))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const planPrompts = deliveries.filter(entry => String(entry.message || '').includes('FOLLOW PLAN'));
  const runs = await api(`/api/tasks/${task.id}/runs`);
  // The timeline is the evidence: who spoke, and when the controller acted.
  report.timeline = events
    .filter(event => event.type === 'USER_MESSAGE' || event.type.startsWith('PLAN_') || event.type === 'TASK_SUCCEEDED' || event.type === 'TASK_FAILED')
    .map(event => ({ at: event.at || event.createdAt || null, type: event.type, message: String(event.message || '').slice(0, 160), mode: event.data?.mode || null, decision: event.data?.decision || null }));
  report.toolNames = Object.entries(toolStarts.reduce((map, event) => {
    const name = event.data?.pi?.toolName || 'tool';
    map[name] = (map[name] || 0) + 1;
    return map;
  }, {}));
  report.counters = {
    planPrompts: planPrompts.length,
    planPromptSteps: planPrompts.map(entry => (/Текущий шаг:\s*(S-\d+)/.exec(entry.message) || [])[1] || 'audit'),
    allPrompts: deliveries.length,
    userMessages: typed('USER_MESSAGE').length,
    userMessagesByMode: typed('USER_MESSAGE').reduce((map, event) => {
      const mode = event.data?.mode || 'prompt';
      map[mode] = (map[mode] || 0) + 1;
      return map;
    }, {}),
    checkpoints: typed('PLAN_STEP_CHECKPOINT').length,
    checkpointDecisions: typed('PLAN_STEP_CHECKPOINT').map(event => event.data?.decision),
    stepStarts: typed('PLAN_STEP_STARTED').length,
    runs: runs.runs?.length ?? 0,
    mutatingToolCalls: toolStarts.filter(event => ['write', 'edit', 'bash'].includes(event.data?.pi?.toolName)).length,
    toolCalls: toolStarts.length
  };
  const onDisk = await fs.readFile(path.join(workspace, 'PLAN.md'), 'utf8');
  report.finalPlanFile = onDisk;
} catch (error) {
  report.error = { message: error.message, code: error.code || null };
  report.logs = logs.slice(-4000);
} finally {
  await stop();
}

await fs.writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Pi: ${report.piVersion} | модель: ${model}`);
console.log(`результат: ${report.result}${report.error ? ` | ошибка: ${report.error.message}` : ''}`);
console.log(`счётчики: ${JSON.stringify(report.counters)}`);
console.log(`шаги: ${(report.plan?.steps || []).map(step => `${step.id}:${step.status}`).join(' ')}`);
console.log(`отчёт: ${path.relative(repo, path.join(out, 'report.json'))}`);
if (report.error || report.result !== 'COMPLETED') process.exitCode = 1;
