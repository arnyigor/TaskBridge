import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TaskStore } from '../src/task-store.mjs';
import { CommandDispatcher, CommandLedger } from '../src/cloud/command-dispatcher.mjs';
import { CommandInbox } from '../src/cloud/command-inbox.mjs';

const command = { commandId: 'followup', machineId: 'pc', taskId: 'session', seq: 1, type: 'FOLLOW_UP', payload: { text: 'continue' } };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-command-inbox-'));
  const store = new TaskStore(root);
  t.after(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, store };
}

test('concurrent redelivery has one effect and changed intent conflicts while it runs', async t => {
  const { store } = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let effects = 0;
  const manager = { getTask: () => ({}), message: async () => { effects++; await gate; } };
  const dispatcher = new CommandDispatcher({ manager, ledger: new CommandLedger({ store }) });
  const first = dispatcher.handle(command);
  const retry = dispatcher.handle({ ...command, seq: 100 });
  const conflict = await dispatcher.handle({ ...command, payload: { text: 'different' } });
  assert.equal(conflict.error.code, 'CONFLICT');
  release();
  assert.equal((await first).status, 'ACCEPTED');
  assert.equal((await retry).status, 'DUPLICATE');
  assert.equal(effects, 1);
  const restarted = new CommandDispatcher({ manager, ledger: new CommandLedger({ store }) });
  assert.equal((await restarted.handle(command)).status, 'DUPLICATE');
  assert.equal(effects, 1);
});

test('an exception after a side effect is replayed as failure instead of executing again', async t => {
  const { store } = await fixture(t);
  let effects = 0;
  const manager = { getTask: () => ({}), message: async () => { effects++; throw new Error('lost runtime answer'); } };
  const make = () => new CommandDispatcher({ manager, ledger: new CommandLedger({ store }) });
  assert.equal((await make().handle(command)).status, 'FAILED');
  assert.equal((await make().handle(command)).status, 'FAILED');
  assert.equal(effects, 1);
});

test('crash after effect but before receipt completion survives SQLite reopen without executing twice', async t => {
  const { root } = await fixture(t);
  const storeUrl = new URL('../src/task-store.mjs', import.meta.url).href;
  const dispatcherUrl = new URL('../src/cloud/command-dispatcher.mjs', import.meta.url).href;
  const code = `
    import { writeFileSync } from 'node:fs';
    import { TaskStore } from ${JSON.stringify(storeUrl)};
    import { CommandDispatcher, CommandLedger } from ${JSON.stringify(dispatcherUrl)};
    const store = new TaskStore(${JSON.stringify(root)});
    const manager = { getTask: () => ({}), message: async () => {
      writeFileSync(${JSON.stringify(path.join(root, 'effect.txt'))}, 'executed');
      process.exit(0);
    } };
    await new CommandDispatcher({ manager, ledger: new CommandLedger({ store }) }).handle(${JSON.stringify(command)});
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(await fs.readFile(path.join(root, 'effect.txt'), 'utf8'), 'executed');
  const reopened = new TaskStore(root);
  try {
    assert.equal(reopened.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    let effects = 0;
    const manager = { getTask: () => ({}), message: async () => { effects++; } };
    const result = await new CommandDispatcher({ manager, ledger: new CommandLedger({ store: reopened }) }).handle(command);
    assert.equal(result.error.code, 'UNKNOWN_AFTER_CRASH');
    assert.equal(effects, 0);
  } finally { reopened.close(); }
});

test('acceptance write failure prevents execution and result write failure preserves unknown outcome', async () => {
  let effects = 0;
  const blocked = new CommandInbox({ store: { upsertCommand() { throw new Error('disk full'); } } });
  assert.equal((await blocked.run(command, () => { effects++; })).error.code, 'COMMAND_LEDGER_FAILED');
  assert.equal(effects, 0);
  let row;
  const store = { getCommand: () => row, upsertCommand(key, entry) { if (entry.done) throw new Error('disk full'); row = entry; } };
  const inbox = new CommandInbox({ store });
  const result = await inbox.run(command, () => { effects++; return { status: 'ACCEPTED' }; });
  assert.equal(result.error.code, 'UNKNOWN_OUTCOME');
  assert.equal((await inbox.run(command, () => { effects++; })).error.code, 'UNKNOWN_AFTER_CRASH');
  assert.equal(effects, 1);
});

test('independent client sequences do not discard new commands when the recent ledger fills', async t => {
  const { store } = await fixture(t);
  let effects = 0;
  const manager = { getTask: () => ({}), message: async () => { effects++; } };
  const dispatcher = new CommandDispatcher({ manager, ledger: new CommandLedger({ store, maxIds: 2 }) });
  for (let i = 0; i < 5; i++) assert.equal((await dispatcher.handle({ ...command, commandId: `c${i}` })).status, 'ACCEPTED');
  assert.equal(effects, 5);
  assert.equal((await dispatcher.handle({ ...command, commandId: 'c0' })).status, 'DUPLICATE');
  assert.equal(effects, 5);
  store.db.prepare("UPDATE commands SET at = 1 WHERE command_id GLOB 'cloud-dispatch:*'").run();
  store.pruneCommands(1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE command_id GLOB 'cloud-dispatch:*'").get().n, 5, 'offline command receipts survive local cache pruning');
});
