import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { startFixture } from './server-fixture.mjs';
import { descendantsOf } from '../src/process-info.mjs';
import { findProtection, realDescendants } from '../src/process-kill.mjs';

// PROC-02 (docs/TASKBRIDGE_RESOURCE_CLEANUP_PLAN.md): a tree kill must not be
// able to reach a protected process through its parent.

test('descendantsOf walks the whole tree and survives a parent cycle', () => {
  const list = [
    { pid: 1, parentPid: null, name: 'root' },
    { pid: 2, parentPid: 1, name: 'child' },
    { pid: 3, parentPid: 2, name: 'grandchild' },
    { pid: 4, parentPid: 3, name: 'great' },
    { pid: 5, parentPid: 42, name: 'unrelated' },
    // Defensive: a stale/cyclic entry must not make the walk loop forever.
    { pid: 7, parentPid: 7, name: 'cycle' },
  ];
  assert.deepEqual(descendantsOf(1, list).map(p => p.pid), [2, 3, 4]);
  assert.deepEqual(descendantsOf(3, list).map(p => p.pid), [4]);
  assert.deepEqual(descendantsOf(5, list), []);
});

test('findProtection flags the self pid, system names and TaskBridge command lines', () => {
  assert.ok(findProtection({ pid: 999, name: 'node.exe', commandLine: 'node server.mjs' }, 999));
  assert.ok(findProtection({ pid: 100, name: 'explorer.exe', commandLine: '' }, 999));
  assert.ok(findProtection({ pid: 101, name: 'node.exe', commandLine: 'node proxy.mjs' }, 999));
  assert.equal(findProtection({ pid: 102, name: 'node.exe', commandLine: 'node worker.js' }, 999), null);
});

test('tree kill refuses when a descendant of the target is a TaskBridge process', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  // A parent whose child's command line names proxy.mjs: killing the parent
  // with /T would take the "protected" child with it — it must be refused.
  // The marker is assembled from parts so the parent's own command line does
  // not contain the literal that findProtection matches.
  const parent = spawn(process.execPath, [
    '-e',
    'const { spawn } = require("node:child_process");' +
    'const marker = "proxy" + "." + "mjs";' +
    'const child = spawn(process.execPath, ["-e", "/* " + marker + " */ setInterval(() => {}, 1000)"], { stdio: "ignore" });' +
    'console.log(child.pid);' +
    'setInterval(() => {}, 1000);',
  ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  t.after(() => {
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
    try { parent.kill('SIGKILL'); } catch {}
  });

  let childPid = 0;
  let line = '';
  parent.stdout.on('data', chunk => {
    line += String(chunk);
    childPid ||= Number(line.trim()) || 0;
  });
  for (let i = 0; i < 40 && !childPid; i++) await new Promise(r => setTimeout(r, 250));
  assert.ok(childPid, 'the parent must report its child pid');

  const attempt = await fixture.api('/api/processes/kill', { pid: parent.pid, name: 'node.exe' })
    .then(value => ({ value }), error => ({ error }));
  assert.ok(attempt.error, 'the kill must be refused');
  assert.equal(attempt.error.code, 'PROTECTED');
  assert.equal(attempt.error.protectedPid, childPid);

  // Both processes must still be alive after the refusal.
  const { processes } = await fixture.api('/api/processes?fresh=1');
  assert.ok(processes.some(p => p.pid === parent.pid), 'parent must survive the refusal');
  assert.ok(processes.some(p => p.pid === childPid), 'protected descendant must survive the refusal');
});

test('tree kill still works when no descendant is protected', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  const parent = spawn(process.execPath, [
    '-e',
    'const { spawn } = require("node:child_process");' +
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });' +
    'console.log(child.pid);' +
    'setInterval(() => {}, 1000);',
  ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  t.after(() => {
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
    try { parent.kill('SIGKILL'); } catch {}
  });

  let childPid = 0;
  let line = '';
  parent.stdout.on('data', chunk => {
    line += String(chunk);
    childPid ||= Number(line.trim()) || 0;
  });
  for (let i = 0; i < 40 && !childPid; i++) await new Promise(r => setTimeout(r, 250));
  assert.ok(childPid, 'the parent must report its child pid');

  const result = await fixture.api('/api/processes/kill', { pid: parent.pid, name: 'node.exe' });
  assert.equal(result.killed, true);

  let gone = 0;
  for (let i = 0; i < 20 && gone < 2; i++) {
    const { processes } = await fixture.api('/api/processes?fresh=1').catch(() => ({ processes: [] }));
    gone = [parent.pid, childPid].filter(pid => !processes.some(p => p.pid === pid)).length;
    if (gone < 2) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(gone, 2, 'both parent and child must be gone after an allowed tree kill');
});

// Переиспользованный PPID: у осиротевшего процесса остаётся номер давно мёртвого
// родителя, и ОС отдаёт этот номер новому процессу. Такой «потомок» не должен
// запрещать законное убийство дерева (флейк на прогоне тестов 2026-10-22:
// TaskBridge.exe оказался в потомках тестового node).
test('потомок, стартовавший раньше родителя, к дереву не относится', () => {
  const target = { pid: 100, startedAt: 1_000_000 };
  const list = [
    { pid: 100, parentPid: 1, startedAt: 1_000_000, name: 'node.exe' },
    // Настоящий ребёнок: стартовал позже.
    { pid: 101, parentPid: 100, startedAt: 1_000_500, name: 'node.exe' },
    // Осиротевший чужой процесс с унаследованным PPID: стартовал задолго до цели.
    { pid: 102, parentPid: 100, startedAt: 500_000, name: 'TaskBridge.exe' },
    { pid: 103, parentPid: 102, startedAt: 500_100, name: 'TaskBridge.exe' },
  ];
  const tree = realDescendants(target, list).map(item => item.pid);
  assert.deepEqual(tree, [101], 'в дереве только настоящий потомок');
  // Неизвестное время старта не выкидывает запись: отказ безопаснее выстрела.
  assert.deepEqual(realDescendants({ pid: 100, startedAt: null }, list).map(item => item.pid), [101, 102, 103]);
});
