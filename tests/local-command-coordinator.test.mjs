import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TaskStore } from '../src/task-store.mjs';
import { CommandCoordinator } from '../src/application/command-coordinator.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-command-coordinator-'));
  const store = new TaskStore(root);
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { store, coordinator: new CommandCoordinator(store) };
}

test('an old HTTP command receipt cannot expire into a second execution', async t => {
  const { store, coordinator } = await fixture(t);
  store.upsertCommand('old', { hash: 'intent', done: true, status: 'COMPLETED', result: { id: 'original' }, at: Date.now() - 3 * 86400000 });
  let effects = 0;
  const result = await coordinator.run('old', 'phone', () => 'intent', async () => { effects++; return { id: 'duplicate' }; });
  assert.equal(effects, 0);
  assert.deepEqual(result, { id: 'original' });
});

test('a result write failure is unknown and never acknowledges or repeats the effect', async t => {
  const { store, coordinator } = await fixture(t);
  const save = store.upsertCommand.bind(store);
  store.upsertCommand = (id, receipt) => {
    if (receipt.done) throw new Error('injected result persistence failure');
    return save(id, receipt);
  };
  let effects = 0;
  const action = async () => { effects++; return { id: 'effect' }; };
  await assert.rejects(coordinator.run('c', 'phone', () => 'intent', action), { code: 'UNKNOWN_OUTCOME' });
  assert.equal(effects, 1);
  assert.equal(store.getCommand('c').done, false);
  await assert.rejects(coordinator.run('c', 'phone', () => 'intent', action), { code: 'UNKNOWN_AFTER_CRASH' });
  const restarted = new CommandCoordinator(store);
  await assert.rejects(restarted.run('c', 'phone', () => 'intent', action), { code: 'UNKNOWN_AFTER_CRASH' });
  assert.equal(effects, 1);
});
