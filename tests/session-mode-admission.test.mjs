import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { FollowPlanService } from '../src/follow-plan-service.mjs';
import { startFixture } from './server-fixture.mjs';

const PLAN = `---
taskbridge_plan: 1
plan_id: p-admission
revision: 1
goal: "Admission"
---
# Admission
## Шаги
### S-001 | TODO | P1 | Check
**Критерии:** checked
**Проверка:** read PLAN.md
## Обнаруженные проблемы
`;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(fn) {
  for (let i = 0; i < 400; i++) {
    const value = await fn();
    if (value) return value;
    await new Promise(r => setTimeout(r, 30));
  }
  throw new Error('Condition timed out');
}

// Gate the first filesystem await after the service takes its task snapshot.
async function gateRead(t, method, target) {
  const original = fs[method], entered = deferred(), release = deferred();
  let gated = false;
  fs[method] = async (...args) => {
    if (!gated && path.resolve(String(args[0])) === path.resolve(target)) {
      gated = true;
      entered.resolve();
      await release.promise;
    }
    return original(...args);
  };
  t.after(() => { release.resolve(); fs[method] = original; });
  return { entered: entered.promise, release: release.resolve };
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-mode-admission-'));
  const store = new TaskStore(root);
  const manager = new TaskManager({ projects: [] }, root, store);
  const task = { id: 'test', mode: 'agent', status: 'SUCCEEDED', workspacePath: root, pendingPrompts: [] };
  manager.tasks.set(task.id, task);
  await store.save(task);
  const service = new FollowPlanService({ manager, store, config: { followPlan: { enabled: true } } });
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, 'PLAN.md'), PLAN);
  return { root, manager, task, service, store };
}

test('saveFile holds mode admission across awaited filesystem work', async t => {
  const { root, manager, task, service } = await setup(t);
  const gate = await gateRead(t, 'realpath', root);
  const saving = service.saveFile({ taskId: task.id, path: 'NEW.md', content: PLAN });
  await gate.entered;
  try {
    await assert.rejects(manager.setSessionMode(task.id, 'chat'), { code: 'BUSY' });
    assert.equal(task.mode, 'agent');
  } finally { gate.release(); await saving; }
  assert.equal(await fs.readFile(path.join(root, 'NEW.md'), 'utf8'), PLAN);
  await manager.setSessionMode(task.id, 'chat');
  await assert.rejects(service.saveFile({ taskId: task.id, path: 'OTHER.md', content: PLAN }), { code: 'INPUT_INVALID' });
});

test('start holds admission before opening a cycle, including queued dispatch', async t => {
  const { root, manager, task, service, store } = await setup(t);
  await service.attach({ taskId: task.id, path: 'PLAN.md' });
  // A queued delivery exercises the nested message admission without launching Pi.
  manager.maxParallelSessions = 1;
  manager.activeTaskIds.add('other');
  const gate = await gateRead(t, 'readFile', path.join(root, 'PLAN.md'));
  const starting = service.start({ taskId: task.id, commandId: 'start-test' });
  await gate.entered;
  try { await assert.rejects(manager.setSessionMode(task.id, 'plan'), { code: 'BUSY' }); }
  finally { gate.release(); await starting; }
  assert.equal(task.pendingPrompts.length, 1);
  const binding = store.getPlanBinding(task.id);
  assert.equal(binding.state, 'RUNNING_STEP');
  assert.equal(task.pendingPrompts[0].commandId, binding.dispatchCommandId);
  assert.equal(store.getCommand(binding.dispatchCommandId).done, true, 'dispatch keeps the command ledger');
  await assert.rejects(manager.setSessionMode(task.id, 'plan'), { code: 'BUSY' });
});

test('all service mutations reject while a mode change owns admission', async t => {
  const { manager, task, service } = await setup(t);
  const entered = deferred(), release = deferred();
  manager.runtimes.set(task.id, { eventChain: Promise.resolve(), settleResolvers: [], pi: {
    getState: async () => { entered.resolve(); await release.promise; return {}; },
    killTreeAndWait: async () => {}
  } });
  const switching = manager.setSessionMode(task.id, 'chat');
  await entered.promise;
  const hooks = [];
  try {
    for (const method of ['attach', 'writeContent', 'saveFile', 'importPlan', 'start', 'pause', 'resume', 'stop', 'patch', 'detach', 'reconcile']) {
      await assert.rejects(service[method]({ taskId: task.id }), { code: 'BUSY' }, method);
    }
    for (const method of ['turnSettled', 'turnCommitted', 'turnFailed']) {
      hooks.push(service[method]({ taskId: task.id }));
    }
  } finally { release.resolve(); await switching; manager.runtimes.clear(); }
  assert.equal(task.mode, 'chat');
  for (const result of await Promise.all(hooks)) assert.equal(result.code, 'IGNORED');
});

test('internal turn hooks wait for mutation admission instead of losing the boundary', async t => {
  const { manager, task, service, store } = await setup(t);
  await service.attach({ taskId: task.id, path: 'PLAN.md' });
  store.savePlanBinding({ ...store.getPlanBinding(task.id), state: 'RUNNING_STEP' });
  const release = deferred();
  const operation = manager.withSessionAdmission(task.id, () => release.promise);
  let finished = false;
  const failed = service.turnFailed({ taskId: task.id }).then(result => { finished = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(store.getPlanBinding(task.id).state, 'RUNNING_STEP');
  release.resolve();
  await operation;
  assert.equal((await failed).code, 'PAUSED_REVIEW');
  assert.equal(store.getPlanBinding(task.id).state, 'PAUSED_REVIEW');
});

test('terminal task cannot switch mode while detached verification shell runs', { timeout: 30000 }, async t => {
  const f = await startFixture(null, { root: { projects: [] } });
  t.after(() => f.close());
  // Configure the fixture project after its temporary root is known.
  const config = JSON.parse(await fs.readFile(path.join(f.root, 'config.json'), 'utf8'));
  const marker = path.join(f.root, 'verification-done');
  const command = `node -e "const fs=require('fs');const first=!fs.existsSync('verification-started');fs.writeFileSync('verification-started','yes');setTimeout(()=>fs.writeFileSync(first?'verification-done':'second-done','done'),first?3000:20)"`;
  config.projects = [{ id: 'fixture', name: 'fixture', path: f.root, useWorktree: false, verification: [command] }];
  await fs.writeFile(path.join(f.root, 'config.json'), JSON.stringify(config));
  await f.restart();
  const created = await f.api('/api/tasks', { projectId: 'fixture', prompt: 'Hello' });
  await until(async () => {
    const task = await f.api(`/api/tasks/${created.id}`);
    return task.status === 'SUCCEEDED' && task.verificationStatus === 'RUNNING';
  });
  await assert.rejects(f.api(`/api/tasks/${created.id}/mode`, { mode: 'chat' }), { code: 'BUSY' });
  await until(() => fs.stat(path.join(f.root, 'verification-started')).then(() => true, () => false));
  await f.api(`/api/tasks/${created.id}/message`, { text: 'Another turn' });
  await until(async () => (await f.api(`/api/tasks/${created.id}`)).verificationStatus === 'PASSED');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' }, 'older verification still runs');
  await assert.rejects(f.api(`/api/tasks/${created.id}/mode`, { mode: 'chat' }), { code: 'BUSY' });
  await until(() => fs.readFile(marker, 'utf8').then(text => text === 'done', () => false));
  const switched = await until(async () => {
    try { return await f.api(`/api/tasks/${created.id}/mode`, { mode: 'chat' }); }
    catch (error) { if (error.code !== 'BUSY') throw error; }
  });
  assert.equal(switched.mode, 'chat');
});
