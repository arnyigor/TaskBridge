import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFixture } from './server-fixture.mjs';

// The open-on-machine routes launch OS applications, so they must be impossible
// to trigger by accident (the contract probe) or from off the machine (a phone,
// the cloud). These checks pin both guards — without ever launching anything.
function post(fixture, routePath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = new URL(fixture.base);
    const payload = JSON.stringify(body ?? {});
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: routePath,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function insertEvent(fixture, taskId, payload) {
  const db = new DatabaseSync(path.join(fixture.root, 'data', 'taskbridge.db'));
  try {
    const seq = Number(db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE task_id = ?').get(taskId).seq);
    db.prepare('INSERT INTO events (task_id, seq, payload) VALUES (?, ?, ?)').run(taskId, seq, JSON.stringify({ taskId, ...payload }));
  } finally {
    db.close();
  }
}

function insertPiToolPath(fixture, taskId, absolutePath) {
  insertEvent(fixture, taskId, {
    type: 'PI_EVENT',
    data: { pi: { type: 'tool_execution_start', toolName: 'read', args: { path: absolutePath } } },
  });
}

function insertMessageToolPath(fixture, taskId, absolutePath) {
  insertEvent(fixture, taskId, {
    type: 'PI_EVENT',
    data: { pi: { type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read', arguments: { path: absolutePath } }] } } },
  });
}

test('open-on-machine routes refuse a missing confirmation and a remote caller', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const task = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'open probe' });
  const route = `/api/tasks/${task.id}/files/00000000-0000-0000-0000-000000000000/open`;

  // No confirm flag: refused before anything can be opened. This is what keeps
  // the contract probe harmless even when it names a file that exists.
  const noConfirm = await post(fixture, route, { body: {} });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.body.code, 'INPUT_INVALID');

  // A phone on the LAN reaches the machine through the reverse proxy: the peer
  // is loopback, and the proxy appended the real client address as the last
  // X-Forwarded-For entry. That address is not this host, so it is refused even
  // with confirmation — a phone can never open things on the PC.
  const remote = await post(fixture, route, { headers: { 'x-forwarded-for': '203.0.113.9' }, body: { confirm: true } });
  assert.equal(remote.status, 403);
  assert.equal(remote.body.code, 'FILE_OPEN_LOCAL_ONLY');

  // From the machine (loopback, no forwarded hop), confirmed, but the file does
  // not exist: 404, still nothing opened.
  const missing = await post(fixture, route, { body: { confirm: true } });
  assert.equal(missing.status, 404);

  // The PC opened the app by its own LAN address through the proxy: the peer is
  // loopback and the proxy appended this host's own address. That is the machine,
  // so the guard passes (and the missing file still answers 404, nothing opened).
  const own = Object.values(os.networkInterfaces()).flat().map(item => item && item.address).find(address => address && !/^127\.|^::1$/.test(address));
  if (own) {
    const pcViaProxy = await post(fixture, route, { headers: { 'x-forwarded-for': own }, body: { confirm: true } });
    assert.equal(pcViaProxy.status, 404, `own forwarded address ${own} is the machine`);
  }
});

test('workspace-file open/run read the path from the query, not an empty body', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const task = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'workspace open probe' });
  const route = `/api/tasks/${task.id}/workspace-file/open`;
  // The workspace is prepared asynchronously; until it exists the route answers
  // 404 for any path, which would hide the check below under load.
  for (let i = 0; i < 200 && !(await fixture.api(`/api/tasks/${task.id}`)).workspacePath; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  // A path in the query is what gets resolved. A missing file 404s — it must not
  // silently fall back to the workspace folder (which the panel then "opened").
  const missing = await post(fixture, `${route}?path=does-not-exist.txt`, { body: { confirm: true } });
  assert.equal(missing.status, 404);
  // The reason is the operator's, not Node's: a file the agent has deleted is the
  // usual cause, and the raw error ("ENOENT … realpath 'G:\…'") also handed the
  // server's own paths to whoever asked, a phone on the LAN included.
  assert.equal(missing.body.code, 'NOT_FOUND');
  assert.match(missing.body.error, /не найден/i);
  assert.doesNotMatch(missing.body.error, /ENOENT|realpath|[A-Za-z]:\\/);

  // Reading such a path — what the file viewer does first — says the same thing
  // instead of painting the raw error in red.
  const read = await fetch(`${fixture.base}/api/tasks/${task.id}/workspace-file?path=does-not-exist.txt`);
  assert.equal(read.status, 404);
  const readBody = await read.json();
  assert.equal(readBody.code, 'NOT_FOUND');
  assert.match(readBody.error, /не найден/i);
  assert.doesNotMatch(readBody.error, /ENOENT|realpath|[A-Za-z]:\\/);

  // No path at all is a client error, not "reveal the folder".
  const empty = await post(fixture, route, { body: { confirm: true } });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, 'INPUT_INVALID');
});

test('workspace-file may read an absolute file only after a tool event named it', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-external-file-'));
  t.after(async () => { await fs.rm(externalDir, { recursive: true, force: true }); await fixture.close(); });
  const task = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'external file probe' });
  for (let i = 0; i < 200 && !(await fixture.api(`/api/tasks/${task.id}`)).workspacePath; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const external = path.join(externalDir, 'outside.txt');
  await fs.writeFile(external, 'outside file contents');
  const route = `/api/tasks/${task.id}/workspace-file?path=${encodeURIComponent(external)}`;

  const before = await fetch(`${fixture.base}${route}`);
  assert.equal(before.status, 400);
  assert.equal((await before.json()).code, 'INPUT_INVALID');

  insertPiToolPath(fixture, task.id, external);
  const afterPi = await fetch(`${fixture.base}${route}`);
  assert.equal(afterPi.status, 200);
  assert.equal(await afterPi.text(), 'outside file contents');

  const second = path.join(externalDir, 'from-message-tool-call.txt');
  await fs.writeFile(second, 'from message tool call');
  const secondRoute = `/api/tasks/${task.id}/workspace-file?path=${encodeURIComponent(second)}`;
  insertMessageToolPath(fixture, task.id, second);
  const afterMessage = await fetch(`${fixture.base}${secondRoute}`);
  assert.equal(afterMessage.status, 200);
  assert.equal(await afterMessage.text(), 'from message tool call');
});

test('run-on-machine routes keep the same guard and never run without it', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const task = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'run probe' });
  const route = `/api/tasks/${task.id}/files/00000000-0000-0000-0000-000000000000/run`;

  const noConfirm = await post(fixture, route, { body: {} });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.body.code, 'INPUT_INVALID');

  // A phone (authenticated client) may run too — but with a missing file it is
  // still 404: nothing is executed. (Opening with a desktop app stays machine
  // only; that is asserted in the open-route test above.)
  const phone = await post(fixture, route, { headers: { 'x-forwarded-for': '203.0.113.9' }, body: { confirm: true } });
  assert.equal(phone.status, 404);

  // From the machine, confirmed, but the file does not exist: 404, still nothing ran.
  const missing = await post(fixture, route, { body: { confirm: true } });
  assert.equal(missing.status, 404);
});

test('the shell route is machine-only and needs confirmation, so nothing runs by accident', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const task = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'shell probe' });
  const route = `/api/tasks/${task.id}/shell`;

  // No confirm flag: 400 before the command is even looked at (this is what keeps
  // the contract probe from running a command on the build machine).
  const noConfirm = await post(fixture, route, { body: { command: 'touch contract-probe-ran' } });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.body.code, 'INPUT_INVALID');

  // Confirmed, from a phone — but the session does not exist, so the guard is
  // checked and the command is still never run (404 before the shell is used).
  const phone = await post(fixture, '/api/tasks/does-not-exist/shell', { headers: { 'x-forwarded-for': '203.0.113.9' }, body: { confirm: true, command: 'touch contract-probe-ran' } });
  assert.equal(phone.status, 404);
});
