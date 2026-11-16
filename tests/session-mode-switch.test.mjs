import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { startFixture } from './server-fixture.mjs';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { PiRpcSession } from '../src/pi-rpc.mjs';
import extension from '../pi-extension/taskbridge-plan.js';

async function until(fn) {
  for (let n = 0; n < 400; n++) {
    const value = await fn();
    if (value) return value;
    await new Promise(r => setTimeout(r, 30));
  }
  throw new Error('Condition timed out');
}
const terminal = (api, id) => until(async () => {
  const task = await api(`/api/tasks/${id}`);
  return ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status) && task;
});
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

test('Chat/Plan/Agent switch kills old runtime, changes launch permissions, preserves history, fork and recovery', { timeout: 60000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-switch-'));
  const dump = path.join(dir, 'launch.json');
  const fixture = await startFixture(null, { env: { FAKE_PI_DUMP_ARGS: dump, TASKBRIDGE_PLAN_ROOT: '/stale', TASKBRIDGE_SESSION_MODE: 'plan' }, root: { followPlan: { enabled: true } } });
  t.after(async () => { await fixture.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const { api } = fixture;
  const launch = async () => JSON.parse(await fs.readFile(dump, 'utf8'));
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'Hello' });
  let task = await terminal(api, created.id);
  assert.equal(task.mode, 'agent', 'legacy/default Agent');
  const agent = await launch();
  assert.ok(agent.argv.some(a => a.includes('taskbridge-follow-plan.js')));
  assert.equal(agent.env.TASKBRIDGE_PLAN_ROOT, undefined, 'Agent drops inherited Plan environment');
  assert.equal(agent.env.TASKBRIDGE_SESSION_MODE, undefined);
  assert.ok(alive(agent.pid));
  await assert.rejects(api(`/api/tasks/${task.id}/mode`, {}), { code: 'INPUT_INVALID' });
  task = await api(`/api/tasks/${task.id}/mode`, { mode: 'chat' });
  assert.equal(task.mode, 'chat');
  assert.equal(alive(agent.pid), false, 'old authorized Pi dead before switch ACK');
  assert.equal(task.piPid, null);
  await api(`/api/tasks/${task.id}/message`, { text: 'Discuss this project' });
  task = await terminal(api, task.id);
  assert.equal(task.status, 'SUCCEEDED');
  assert.equal(task.planReports, undefined, 'Chat creates no Plan reports');
  assert.equal(task.verificationStatus, 'NOT_APPLICABLE');
  const chat = await launch();
  for (const flag of ['--no-mcp', '--no-extensions', '--no-builtin-tools', '--no-context-files', '--no-skills', '--no-prompt-templates']) assert.ok(chat.argv.includes(flag), flag);
  assert.equal(chat.env.TASKBRIDGE_SESSION_MODE, 'chat');
  assert.equal(chat.env.TASKBRIDGE_PLAN_ROOT, task.workspacePath);
  assert.ok(!chat.argv.some(a => /taskbridge-(follow-plan|approvals|external|turn-instructions)/.test(a)));
  assert.ok(chat.argv.includes('--session'), 'restores native Pi history');
  const sessionFile = chat.argv[chat.argv.indexOf('--session') + 1];
  const history = await fs.readFile(sessionFile, 'utf8');
  assert.match(history, /Hello/);
  assert.match(history, /Discuss this project/);
  for (const text of ['/anything', '!echo unsafe']) await assert.rejects(api(`/api/tasks/${task.id}/message`, { text }), { code: 'INPUT_INVALID' });
  await assert.rejects(api(`/api/tasks/${task.id}/message`, { text: 'x', files: [{ name: 'x', base64: 'eA==' }] }), { code: 'INPUT_INVALID' });
  await assert.rejects(api(`/api/tasks/${task.id}/plan/attach`, { path: 'x.md', commandId: 'blocked-chat' }), { code: 'INPUT_INVALID' });
  assert.equal((await api(`/api/tasks/${task.id}/plan`)).enabled, false);
  const fork = await api(`/api/tasks/${task.id}/fork`, { turnId: 'assistant-initial' });
  assert.equal(fork.mode, 'chat');
  await fixture.restart();
  assert.equal((await api(`/api/tasks/${task.id}`)).mode, 'chat');
  await api(`/api/tasks/${task.id}/message`, { text: 'Continue discussion' });
  task = await terminal(api, task.id);
  assert.equal(task.status, 'SUCCEEDED');
  task = await api(`/api/tasks/${task.id}/mode`, { mode: 'plan' });
  await api(`/api/tasks/${task.id}/message`, { text: 'Research a plan' });
  task = await terminal(api, task.id);
  assert.equal(task.planReports.length, 1);
  const plan = await launch();
  assert.equal(plan.env.TASKBRIDGE_SESSION_MODE, 'plan');
  await assert.rejects(api(`/api/tasks/${task.id}/plan/attach`, { path: 'x.md', commandId: 'blocked-plan' }), { code: 'INPUT_INVALID' });
  task = await api(`/api/tasks/${task.id}/mode`, { mode: 'agent' });
  assert.equal(alive(plan.pid), false);
  await api(`/api/tasks/${task.id}/message`, { text: 'Agent again' });
  task = await terminal(api, task.id);
  assert.equal(task.status, 'SUCCEEDED');
  assert.equal(task.planReports.length, 1, 'Agent creates no additional Plan report');
  const restored = await launch();
  assert.ok(!restored.argv.includes('--no-builtin-tools'));
  assert.ok(!restored.argv.some(a => a.endsWith('taskbridge-plan.js')));
  assert.equal(restored.env.TASKBRIDGE_PLAN_ROOT, undefined);
  assert.equal(restored.env.TASKBRIDGE_SESSION_MODE, undefined);
  assert.ok(restored.argv.some(a => a.includes('taskbridge-follow-plan.js')));
  assert.match(await fs.readFile(restored.argv[restored.argv.indexOf('--session') + 1], 'utf8'), /Continue discussion/);
});

test('busy switch rejected without changing mode or killing runtime; import cannot bypass read-only mode', { timeout: 60000 }, async t => {
  const f = await startFixture();
  t.after(() => f.close());
  for (const mode of ['chat', 'plan']) {
    await assert.rejects(f.api('/api/tasks/from-session', { mode, projectId: 'fixture', key: 'unused' }), { code: 'INPUT_INVALID' });
    await assert.rejects(f.api('/api/tasks/from-session', { mode: 'clone', sessionMode: mode, projectId: 'fixture', key: 'unused' }), { code: 'INPUT_INVALID' });
    await assert.rejects(f.api('/api/tasks', { mode, projectId: 'fixture', prompt: '!unsafe' }), { code: 'INPUT_INVALID' });
    await assert.rejects(f.api('/api/tasks', { mode, projectId: 'fixture', prompt: 'x', files: [{ name: 'x', base64: 'eA==' }] }), { code: 'INPUT_INVALID' });
  }
  const chat = await f.api('/api/tasks', { projectId: 'fixture', mode: 'chat', prompt: 'A normal conversation' });
  const answered = await terminal(f.api, chat.id);
  assert.equal(answered.mode, 'chat');
  assert.equal(answered.status, 'SUCCEEDED');
  assert.equal(answered.planReports, undefined);
  assert.equal(answered.checkpoint, undefined);
  const created = await f.api('/api/tasks', { projectId: 'fixture', prompt: 'fault-hang' });
  const running = await until(async () => { const task = await f.api(`/api/tasks/${created.id}`); return task.status === 'RUNNING' && task.piPid && task; });
  await assert.rejects(f.api(`/api/tasks/${created.id}/mode`, { mode: 'chat' }), { code: 'BUSY' });
  assert.equal((await f.api(`/api/tasks/${created.id}`)).mode, 'agent');
  assert.ok(alive(running.piPid));
  await f.api(`/api/tasks/${created.id}/cancel`, {});
});

test('mode switch fails closed on termination failure; preserves native session ownership', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-switch-unit-'));
  const store = new TaskStore(dir);
  const manager = new TaskManager({ projects: [] }, dir, store);
  t.after(async () => { manager.runtimes.clear(); store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const task = { id: 'test', status: 'SUCCEEDED', mode: 'agent', piSessionFile: '/native/file.jsonl', nativeSession: { kind: 'owned' }, pendingPrompts: [] };
  manager.tasks.set(task.id, task);
  const runtime = { eventChain: Promise.resolve(), settleResolvers: [], pi: { getState: async () => ({ isStreaming: false }), killTreeAndWait: async () => { throw Object.assign(new Error('not dead'), { code: 'BUSY' }); } } };
  manager.runtimes.set(task.id, runtime);
  for (const busy of [{ pendingPrompts: [{ text: 'queued' }] }, { _compacting: true }, { _starting: true }, { _toolsRunning: 1 }, { inFlightPrompt: { text: 'pending' } }]) {
    Object.assign(task, busy);
    await assert.rejects(manager.setSessionMode(task.id, 'chat'), { code: 'BUSY' });
    assert.equal(runtime.retired, undefined);
    for (const key of Object.keys(busy)) delete task[key];
  }
  runtime.pi.getState = async () => ({ isCompacting: true });
  await assert.rejects(manager.setSessionMode(task.id, 'chat'), { code: 'BUSY' });
  assert.equal(runtime.retired, undefined);
  runtime.pi.getState = async () => ({ isStreaming: false });

  await assert.rejects(manager.setSessionMode(task.id, 'chat'), { code: 'BUSY' });
  assert.equal(task.mode, 'agent');
  assert.equal(runtime.retired, true);
  assert.equal(manager.runtimes.get(task.id), runtime);
  runtime.pi.killTreeAndWait = async () => {};
  await manager.setSessionMode(task.id, 'chat');
  assert.equal(task.mode, 'chat');
  assert.equal(task.piSessionFile, '/native/file.jsonl');
  assert.deepEqual(task.nativeSession, { kind: 'owned' });
  assert.equal(manager.runtimes.has(task.id), false);
});

test('termination barrier waits for process close, rejects missing confirmation', async () => {
  const pi = new PiRpcSession({});
  pi.proc = new EventEmitter();
  pi.killTree = async () => { setTimeout(() => pi.proc.emit('close'), 20); };
  await pi.killTreeAndWait(200);
  pi.killTree = async () => {};
  await assert.rejects(pi.killTreeAndWait(10), { code: 'BUSY' });
});

test('read-only extension registers only confined read/search; Chat prompt is conversational, Plan remains a report', () => {
  const before = { root: process.env.TASKBRIDGE_PLAN_ROOT, mode: process.env.TASKBRIDGE_SESSION_MODE };
  try {
    process.env.TASKBRIDGE_PLAN_ROOT = os.tmpdir();
    for (const mode of ['chat', 'plan']) {
      process.env.TASKBRIDGE_SESSION_MODE = mode;
      const tools = [], handlers = {};
      extension({ registerTool: tool => tools.push(tool), on: (event, handler) => { handlers[event] = handler; } });
      assert.deepEqual(tools.map(t => t.name), ['taskbridge_plan_read', 'taskbridge_plan_search']);
      const event = { systemPromptOptions: { sections: {} } };
      handlers.before_agent_start(event);
      const prompt = event.systemPromptOptions.sections.taskbridge_plan_mode;
      assert.match(prompt, mode === 'chat' ? /Respond conversationally.*no mandatory plan or report/ : /adaptive Markdown plan/);
      if (mode === 'chat') assert.doesNotMatch(prompt, /versioned report/);
    }
  } finally {
    for (const [key, value] of [['TASKBRIDGE_PLAN_ROOT', before.root], ['TASKBRIDGE_SESSION_MODE', before.mode]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
