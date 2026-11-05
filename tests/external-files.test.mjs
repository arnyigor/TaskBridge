import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { ExternalFilesService, relativeExternalPath } from '../src/external-files/service.mjs';
import { windowsRead } from '../src/external-files/windows-reader.mjs';
import { createExternalRoutes } from '../src/external-files/routes.mjs';
import { AccessControl } from '../src/auth.mjs';
import { UploadStore } from '../src/uploads.mjs';

const command = () => crypto.randomUUID();
async function fixture(t, reader) {
  await fs.mkdir('.local', { recursive: true });
  const base = await fs.mkdtemp(path.resolve('.local/external-files-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'Downloads');
  const outside = path.join(base, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'hello.txt'), 'allowed content');
  await fs.writeFile(path.join(outside, 'payload.txt'), 'OUTSIDE SECRET');
  const project = { id: 'project', path: root, externalReadDirectories: [{ id: 'downloads', path: root, enabled: true, canBrowse: true, canPreview: true, canAttach: true, agentCanRead: true, allowModelTransfer: true }] };
  const manager = { projects: new Map([['project', project], ['other', { id: 'other' }]]), runtimes: new Map(), uploads: new UploadStore(base), getTask(id) { return ['chat', 'another-chat'].includes(id) ? { id, projectId: 'project', sourcePath: root } : null; } };
  const service = new ExternalFilesService({ manager, dataRoot: base, ...(reader ? { reader } : {}) });
  await service.init();
  return { base, root, outside, manager, service };
}

const textReader = async () => ({ base64: Buffer.from('allowed content').toString('base64'), size: 15 });

test('relative paths reject traversal, ADS, namespaces, encoded separators and private names', () => {
  for (const value of ['../a', '/a', 'a//b', 'a/./b', 'a/../b', 'C:/file.txt', '\\\\pc\\share', 'a\\b', 'a:stream', 'a.', 'NUL.txt', '.env', '.npmrc', '.ssh/key.txt', 'a/.git/config', 'credentials.json', 'x.pem']) assert.throws(() => relativeExternalPath(value), { code: 'FILE_FORBIDDEN' });
  assert.equal(relativeExternalPath('folder/image.png'), 'folder/image.png');
});

test('permissions are independent, project-scoped and require explicit model-transfer consent', async t => {
  const { service, manager } = await fixture(t, textReader);
  const project = manager.projects.get('project');
  project.externalReadDirectories[0].agentCanRead = false;
  assert.equal((await service.preview('project', 'downloads', 'hello.txt')).bytes.toString(), 'allowed content');
  await assert.rejects(service.agent('project', 'downloads', 'hello.txt', 'read'), { code: 'FILE_FORBIDDEN' });
  project.externalReadDirectories[0].agentCanRead = true;
  project.externalReadDirectories[0].allowModelTransfer = false;
  await assert.rejects(service.agent('project', 'downloads', 'hello.txt', 'read'), { code: 'FILE_FORBIDDEN' });
  await assert.rejects(service.prepare('chat', { rootId: 'downloads', path: 'hello.txt', expectedRevision: 0, commandId: command() }, 'device'), { code: 'FILE_FORBIDDEN' });
  await assert.rejects(service.preview('other', 'downloads', 'hello.txt'), { code: 'FILE_FORBIDDEN' });
});

test('revocation during an in-flight read discards its bytes and persists across restart', async t => {
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const reader = () => new Promise(resolve => { release = () => resolve({ base64: 'aGVsbG8=', size: 5 }); entered(); });
  const { service, manager, base } = await fixture(t, reader);
  const reading = service.preview('project', 'downloads', 'hello.txt');
  await ready;
  await service.toggle('project', 'downloads', { enabled: false, expectedRevision: 0, commandId: command() }, 'phone');
  release();
  await assert.rejects(reading, { code: 'FILE_FORBIDDEN' });
  const restarted = new ExternalFilesService({ manager, dataRoot: base, reader });
  await restarted.init();
  assert.equal((await restarted.settings('project')).roots[0].enabled, false);
  assert.equal((await restarted.settings('project')).revision, 1);
});

test('requests, decisions, revisions and idempotency are durable and project-bound', async t => {
  const { service, root } = await fixture(t, textReader);
  const input = { path: root, permissions: ['browse'], expectedRevision: 0, commandId: command() };
  const request = await service.request('project', input, 'phone');
  assert.equal((await service.request('project', input, 'phone')).id, request.id);
  await assert.rejects(service.request('other', input, 'phone'), { code: 'INPUT_INVALID' });
  const decision = { decision: 'APPROVED', path: root, expectedRevision: 0, commandId: command() };
  await service.decision('project', request.id, decision, 'local');
  assert.equal((await service.decision('project', request.id, decision, 'local')).status, 'APPROVED');
  const settings = await service.settings('project');
  assert.equal(settings.revision, 1);
  const granted = settings.roots.find(item => item.id === `root-${request.id}`);
  assert.equal(granted.canBrowse, true);
  assert.equal(granted.agentCanRead, false);
  assert.equal(granted.canPreview, false);
  assert.equal(granted.canAttach, false);
  assert.equal(settings.requests[0].requestedPath, null);
  assert.equal(service.requests('project', true)[0].requestedPath, root);
  await assert.rejects(service.toggle('project', 'downloads', { enabled: false, expectedRevision: 0, commandId: command() }, 'phone'), { code: 'REVISION_CONFLICT' });
});

test('attachment is a stable snapshot, scoped to actor/chat/project and expiring', async t => {
  const { service, manager } = await fixture(t, textReader);
  const body = { rootId: 'downloads', path: 'hello.txt', expectedRevision: 0, commandId: command() };
  const result = await service.prepare('chat', body, 'phone');
  assert.deepEqual(await service.prepare('chat', body, 'phone'), result);
  await manager.uploads.authorize(result.token, { taskId: 'chat', projectId: 'project', actor: 'phone' });
  for (const context of [{ taskId: 'another-chat', projectId: 'project', actor: 'phone' }, { taskId: 'chat', projectId: 'other', actor: 'phone' }, { taskId: 'chat', projectId: 'project', actor: 'other-device' }]) await assert.rejects(manager.uploads.authorize(result.token, context), { code: 'FILE_FORBIDDEN' });
  const [file] = await manager.uploads.resolve(result.token, result.files, { taskId: 'chat', projectId: 'project' });
  assert.equal(await fs.readFile(file.sourcePath, 'utf8'), 'allowed content');
  const bindingFile = path.join(manager.uploads.root, result.token, 'binding.json');
  const binding = JSON.parse(await fs.readFile(bindingFile));
  await fs.writeFile(bindingFile, JSON.stringify({ ...binding, expiresAt: 1 }));
  await assert.rejects(manager.uploads.authorize(result.token, { taskId: 'chat', projectId: 'project', actor: 'phone' }), { code: 'FILE_FORBIDDEN' });
});

test('local permanent revocation cannot be undone remotely and invalidates unsent snapshots', async t => {
  const { service, manager } = await fixture(t, textReader);
  const snapshot = await service.prepare('chat', { rootId: 'downloads', path: 'hello.txt', expectedRevision: 0, commandId: command() }, 'phone');
  await service.revoke('project', 'downloads', { expectedRevision: 0, commandId: command() }, 'local');
  await assert.rejects(service.toggle('project', 'downloads', { enabled: true, expectedRevision: 1, commandId: command() }, 'phone'), { code: 'FILE_FORBIDDEN' });
  await assert.rejects(manager.uploads.authorize(snapshot.token, { taskId: 'chat', projectId: 'project', actor: 'phone' }));
  assert.equal((await service.roots('project'))[0].revoked, true);
});

test('a reused project ID never inherits grants, requests or an old task capability', async t => {
  const { service, manager, base, outside } = await fixture(t, textReader);
  await service.toggle('project', 'downloads', { enabled: false, expectedRevision: 0, commandId: command() }, 'phone');
  await service.request('project', { path: outside, permissions: ['browse'], expectedRevision: 1, commandId: command() }, 'phone');
  manager.projects.set('project', { id: 'project', path: outside, registrationId: command() });
  await service.request('project', { path: outside, permissions: ['browse'], expectedRevision: 0, commandId: command() }, 'phone');
  assert.equal((await service.roots('project')).length, 0);
  assert.equal(service.requests('project').length, 1);
  assert.throws(() => service.taskProject('chat'), { code: 'FILE_FORBIDDEN' });
  const restarted = new ExternalFilesService({ manager, dataRoot: base, reader: textReader });
  await restarted.init();
  assert.equal((await restarted.roots('project')).length, 0);
});

test('missing saved roots do not prevent startup or fabricate availability', async t => {
  const { service, root, base, manager } = await fixture(t, textReader);
  await service.toggle('project', 'downloads', { enabled: false, expectedRevision: 0, commandId: command() }, 'phone');
  await fs.rm(root, { recursive: true });
  const restarted = new ExternalFilesService({ manager, dataRoot: base, reader: textReader });
  await restarted.init();
  assert.equal((await restarted.roots('project'))[0].available, false);
});

test('audit records allow and deny without file contents or absolute paths', async t => {
  const { service, root } = await fixture(t, textReader);
  await service.preview('project', 'downloads', 'hello.txt');
  await assert.rejects(service.preview('project', 'downloads', '../payload.txt'));
  const audit = JSON.stringify(service.state.audit);
  assert.match(audit, /allowed/); assert.match(audit, /denied/);
  assert.equal(audit.includes(root), false);
  assert.equal(audit.includes('allowed content'), false);
  assert.equal(audit.includes('hello.txt'), false);
});

test('Windows handles read normal files and deny junctions, hard links, writers and oversize files', { skip: process.platform !== 'win32' }, async t => {
  const { service, root, outside } = await fixture(t);
  assert.equal((await service.preview('project', 'downloads', 'hello.txt')).bytes.toString(), 'allowed content');
  await fs.mkdir(path.join(root, 'folder'));
  await fs.writeFile(path.join(root, 'folder', 'one.txt'), 'inside');
  await fs.symlink(outside, path.join(root, 'escape'), 'junction');
  await fs.link(path.join(outside, 'payload.txt'), path.join(root, 'hard.txt'));
  await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(2097153, 65));
  await assert.rejects(service.preview('project', 'downloads', 'escape/payload.txt'), { code: 'FILE_FORBIDDEN' });
  await assert.rejects(service.preview('project', 'downloads', 'hard.txt'), { code: 'FILE_FORBIDDEN' });
  await assert.rejects(service.preview('project', 'downloads', 'large.txt'), { code: 'BODY_TOO_LARGE' });
  const writer = await fs.open(path.join(root, 'hello.txt'), 'r+');
  try { await assert.rejects(service.preview('project', 'downloads', 'hello.txt'), { code: 'FILE_FORBIDDEN' }); }
  finally { await writer.close(); }
  const listing = await service.browse('project', 'downloads');
  assert.equal(listing.entries.some(item => item.name === 'escape'), false);
  assert.equal(listing.entries.some(item => item.name === 'folder'), true);
});

test('Windows junction replacement race never returns outside bytes', { skip: process.platform !== 'win32' }, async t => {
  const { service, root, outside } = await fixture(t);
  const folder = path.join(root, 'moving');
  const parked = path.join(root, 'parked');
  await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'payload.txt'), 'inside');
  let stop = false;
  const attack = (async () => {
    while (!stop) {
      try {
        await fs.rename(folder, parked);
        try { await fs.symlink(outside, folder, 'junction'); await fs.unlink(folder); }
        finally { await fs.rename(parked, folder).catch(() => {}); }
      } catch { await new Promise(resolve => setTimeout(resolve, 1)); }
    }
  })();
  try {
    for (let i = 0; i < 4; i++) {
      try { assert.equal((await service.preview('project', 'downloads', 'moving/payload.txt')).bytes.toString(), 'inside'); }
      catch (error) { assert.equal(error.code, 'FILE_FORBIDDEN'); }
    }
  } finally { stop = true; await attack; }
});

test('HTTP enforces real local identity, CSRF, scoped Pi tokens and remote requests', async t => {
  const { service, manager, base, root } = await fixture(t, textReader);
  const access = new AccessControl({ enabled: true }, base);
  await access.init();
  const { token } = await access.addDevice({ name: 'phone claiming desktop', kind: 'desktop' });
  const routes = createExternalRoutes({ service, manager, access,
    json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); },
    async readJson(req) { let data = ''; for await (const chunk of req) data += chunk; return JSON.parse(data); },
  });
  const server = http.createServer(async (req, res) => {
    try {
      access.checkOrigin(req);
      const url = new URL(req.url, 'http://localhost');
      if (await routes.internal(req, res, url)) return;
      access.require(req);
      if (await routes.client(req, res, url)) return;
      res.writeHead(404).end();
    } catch (error) { res.writeHead(error.code === 'REVISION_CONFLICT' ? 409 : error.code === 'AUTH_REQUIRED' ? 401 : 403); res.end(JSON.stringify({ code: error.code })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  // Fully drain each response and own each socket. Undici's global dispatcher
  // can crash this Node/Windows runtime during --test-force-exit teardown.
  const fetch = (url, options = {}) => new Promise((resolve, reject) => {
    const request = http.request(url, { method: options.method || 'GET', headers: options.headers, agent: false }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, json: async () => JSON.parse(text) }));
    });
    request.on('error', reject);
    request.end(options.body);
  });
  const remote = { authorization: `Bearer ${token}`, 'x-forwarded-for': '192.168.1.10', 'content-type': 'application/json' };
  const pendingResponse = await fetch(`${baseUrl}/api/projects/project/external-read/requests`, { method: 'POST', headers: remote, body: JSON.stringify({ path: root, permissions: ['browse'], expectedRevision: 0, commandId: command() }) });
  assert.equal(pendingResponse.status, 201);
  const pending = await pendingResponse.json();
  assert.equal(pending.requestedPath, null);
  const decisionUrl = `${baseUrl}/api/projects/project/external-read/requests/${pending.id}/decision`;
  const body = JSON.stringify({ decision: 'APPROVED', path: root, expectedRevision: 0, commandId: command() });
  assert.equal((await fetch(decisionUrl, { method: 'POST', headers: remote, body })).status, 403);
  assert.equal((await fetch(decisionUrl, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.invalid' }, body })).status, 403);
  assert.equal((await fetch(decisionUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 200);
  const cap = routes.issue('chat');
  manager.runtimes.set('chat', { pi: { closed: false } });
  const internal = `${baseUrl}/api/internal/external-files/chat/open`;
  const params = JSON.stringify({ rootId: 'downloads', path: 'hello.txt' });
  assert.equal((await fetch(internal, { method: 'POST', headers: { ...remote, 'x-taskbridge-external-token': cap.token }, body: params })).status, 403);
  assert.equal((await fetch(internal, { method: 'POST', headers: { 'content-type': 'application/json', 'x-taskbridge-external-token': cap.token }, body: params })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/internal/external-files/another-chat/open`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-taskbridge-external-token': cap.token }, body: params })).status, 403);
  cap.revoke();
  assert.equal((await fetch(internal, { method: 'POST', headers: { 'content-type': 'application/json', 'x-taskbridge-external-token': cap.token }, body: params })).status, 403);
});
