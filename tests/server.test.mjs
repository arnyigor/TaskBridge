import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';
import { TaskStore } from '../src/task-store.mjs';
import { ChatState } from '../web/chat-state.mjs';

// Minimal llama.cpp router stand-in for the /api/local tests.
async function fakeRouter(t) {
  const status = new Map([['vision', 'unloaded'], ['text', 'unloaded']]);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') return res.end(JSON.stringify({ status: 'ok' }));
    if (req.method === 'GET' && url.pathname === '/models') {
      return res.end(JSON.stringify({
        data: [...status.entries()].map(([id, value]) => ({
          id,
          status: { value },
          architecture: { input_modalities: id === 'vision' ? ['text', 'image'] : ['text'] },
          meta: { n_ctx: 33792 }
        }))
      }));
    }
    if (req.method === 'POST' && url.pathname === '/models/load') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => { status.set(JSON.parse(body).model, 'loaded'); res.end('{}'); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/models/unload') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => { status.set(JSON.parse(body).model, 'unloaded'); res.end('{}'); });
      return;
    }
    if (url.pathname === '/models/sse') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ok\n\n'); return; }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function terminal(api, id) {
  for (let i = 0; i < 150; i++) {
    const task = await api(`/api/tasks/${id}`);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Task did not finish');
}

test('a task can be created from files alone and LAN callers cannot choose its id', { timeout: 20000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: '', requestedId: 'untrusted_id', files: [{ name: 'note.txt', size: 1, base64: 'eA==' }] });
  assert.notEqual(created.id, 'untrusted_id');
  assert.equal(created.prompt, 'Прикреплённые файлы');
  let task = null;
  for (let i = 0; i < 150; i++) {
    task = await api(`/api/tasks/${created.id}`);
    if (['SUCCEEDED', 'FAILED'].includes(task.status)) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(task.status, 'SUCCEEDED', fixture.logs());
  assert.equal(task.attachments.length, 1);
});

test('multipart upload streams files into the task workspace and discards staging', { timeout: 20000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api, base, root } = fixture;
  const form = new FormData();
  form.append('files', new Blob([Buffer.from('привет upload\n')]), 'заметка.txt');
  form.append('files', new Blob([Buffer.from([0, 1, 2, 255, 0])]), 'data.bin');
  const response = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { 'x-taskbridge-upload': '1' }, body: form });
  assert.equal(response.status, 201, fixture.logs());
  const upload = await response.json();
  assert.equal(upload.files.length, 2);
  assert.equal(upload.files[0].name, 'заметка.txt');
  assert.equal(upload.files[0].size, Buffer.byteLength('привет upload\n'));
  assert.match(upload.token, /^[a-f0-9-]{36}$/);
  const created = await api('/api/tasks', {
    projectId: 'fixture', prompt: 'with upload',
    files: upload.files.map(file => ({ id: file.id })), uploadToken: upload.token
  });
  let task = null;
  for (let i = 0; i < 150; i++) {
    task = await api(`/api/tasks/${created.id}`);
    if (['SUCCEEDED', 'FAILED'].includes(task.status)) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(task.status, 'SUCCEEDED', fixture.logs());
  assert.equal(task.attachments.length, 2);
  assert.ok(task.attachments.every(file => file.path.startsWith('.taskbridge-input/')));
  const note = task.attachments.find(file => file.name === 'заметка.txt');
  const served = await fetch(`${base}/api/tasks/${created.id}/files/${note.id}`);
  assert.equal(Buffer.from(await served.arrayBuffer()).toString('utf8'), 'привет upload\n');
  // The staging directory is removed once the task owns the files.
  assert.deepEqual(await fs.readdir(path.join(root, 'data', 'uploads')).catch(() => []), []);
});

test('events requests are capped by server.maxEventsPerRequest', { timeout: 20000 }, async t => {
  const fixture = await startFixture(undefined, { server: { maxEventsPerRequest: 5 } });
  t.after(() => fixture.close());
  const { api, root } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'cap' });
  let task = null;
  for (let i = 0; i < 150; i++) {
    task = await api(`/api/tasks/${created.id}`);
    if (['SUCCEEDED', 'FAILED'].includes(task.status)) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  // Count the real rows through a second connection to the same database.
  const store = new TaskStore(path.join(root, 'data'));
  const total = Number(store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE task_id = ?').get(created.id).n);
  store.close();
  assert.ok(total > 5, `expected more than 5 stored events, got ${total}`);
  const capped = await api(`/api/tasks/${created.id}/events?limit=0`);
  assert.ok(capped.length > 0 && capped.length <= 5, `capped length ${capped.length}`);
});

test('Pi models can be listed and switched for a session', { timeout: 30000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;

  const catalog = await api('/api/models');
  assert.deepEqual(catalog.models.map(m => `${m.provider}/${m.id}`), ['fixture/fixture', 'other/other']);
  assert.ok(catalog.thinkingLevels.includes('high'));
  assert.deepEqual(catalog.models.find(m => m.id === 'other'), { provider: 'other', id: 'other', name: 'Other', contextWindow: 8000, maxTokens: 512, reasoning: false, images: true });

  // A model chosen for a new task is passed to Pi as --provider/--model, and the
  // thinking level as --thinking; the captured state reflects the selection.
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'model', model: { provider: 'other', id: 'other' }, thinkingLevel: 'low' });
  assert.deepEqual(created.requestedModel, { provider: 'other', id: 'other' });
  const id = created.id;
  let task = await terminal(api, id);
  assert.equal(task.status, 'SUCCEEDED', fixture.logs());
  assert.equal(task.model.provider, 'other');
  assert.equal(task.model.id, 'other');
  assert.equal(task.thinkingLevelActual, 'low');

  // Live switch, as the UI does it.
  const switched = await api(`/api/tasks/${id}/model`, { provider: 'fixture', id: 'fixture' });
  assert.equal(switched.model.provider, 'fixture');
  assert.equal(switched.model.id, 'fixture');
  assert.deepEqual((await api(`/api/tasks/${id}`)).requestedModel, { provider: 'fixture', id: 'fixture' });
  assert.ok((await api(`/api/tasks/${id}/events?limit=0`)).some(e => e.type === 'MODEL_SWITCH'));

  await api(`/api/tasks/${id}/thinking`, { level: 'high' });
  const afterThinking = await api(`/api/tasks/${id}`);
  assert.equal(afterThinking.thinkingLevel, 'high');
  assert.equal((await api(`/api/tasks/${id}/state`)).state.thinkingLevel, 'high');
});

test('router mode exposes /api/local and warns when Pi blocks images', { timeout: 20000 }, async t => {
  const router = await fakeRouter(t);
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-pi-agent-'));
  t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ images: { blockImages: true } }));
  const fixture = await startFixture(undefined, {
    env: { PI_AGENT_DIR: agentDir },
    root: { localRuntime: { provider: 'llama.cpp', healthUrl: `${router}/health`, router: { enabled: true } } }
  });
  t.after(() => fixture.close());
  const { api } = fixture;

  const local = await api('/api/local');
  assert.equal(local.enabled, true);
  assert.equal(local.provider, 'llama.cpp');
  assert.deepEqual(local.models.map(m => m.id), ['vision', 'text']);
  assert.equal(local.models.find(m => m.id === 'vision').vision, true);

  const loaded = await api('/api/local/load', { model: 'vision' });
  assert.deepEqual(loaded.loaded, ['vision']);

  const info = await api('/api/info');
  assert.equal(info.local.enabled, true);
  assert.ok(info.warnings.some(w => w.code === 'PI_IMAGES_BLOCKED'), JSON.stringify(info.warnings));

  await api('/api/local/unload', { model: 'vision' });
  assert.deepEqual((await api('/api/local')).loaded, []);
});

test('MCP endpoints switch mode, import from Pi and toggle servers', { timeout: 20000 }, async t => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-pi-mcp-agent-'));
  t.after(() => fs.rm(agentDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({
    mcpServers: { serena: { command: 'serena' }, 'image-description-engine': { command: 'python' } }
  }));
  const fixture = await startFixture(undefined, { env: { PI_AGENT_DIR: agentDir } });
  t.after(() => fixture.close());
  const { api } = fixture;

  const initial = await api('/api/mcp');
  assert.equal(initial.mode, 'inherit');

  const managed = await api('/api/mcp/mode', { mode: 'managed' });
  assert.equal(managed.mode, 'managed');
  assert.deepEqual(managed.servers.map(s => s.name), ['image-description-engine', 'serena']);

  const toggled = await api('/api/mcp/servers', { name: 'image-description-engine', enabled: false });
  assert.equal(toggled.servers.find(s => s.name === 'image-description-engine').disabled, true);
  assert.equal(toggled.servers.find(s => s.name === 'serena').disabled, false);

  const reimported = await api('/api/mcp/import', {});
  assert.equal(reimported.servers.every(s => !s.disabled), true);
});

test('HTTP + Pi RPC: follow-up, history replay, SSE cursor, rejected send, compact, cancel, deletion', { timeout: 20000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api, base } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'hello' });
  const id = created.id;
  let task = await terminal(api, id);
  assert.equal(task.status, 'SUCCEEDED', fixture.logs());
  assert.deepEqual(task.engine, { profileId: null, auto: false, reason: null });
  assert.equal(task.lastUsage.totalTokens, 1100);
  await api(`/api/tasks/${id}/message`, { text: 'continue', files: [{ name: 'sample.txt', size: 1, base64: 'eA==' }] });
  task = await terminal(api, id);
  assert.equal(task.status, 'SUCCEEDED');
  const events = await api(`/api/tasks/${id}/events?limit=0`);
  const state = new ChatState(task);
  for (const event of events) state.apply(event);
  state.snapshot(task);
  assert.deepEqual(state.turns.filter(x => x.role === 'assistant').map(x => x.text), ['Ответ 1', 'Ответ 2']);
  assert.equal(state.turns[2].files[0].name, 'sample.txt');
  assert.equal(state.current.active, false);
  // Restart with no live runtime: import complete persisted events into Pi, keep
  // the same TaskBridge id and include the prior turns in the resumed process.
  await fixture.restart();
  await api(`/api/tasks/${id}/message`, { text: 'after restart' });
  task = await terminal(api, id);
  assert.equal(task.status, 'SUCCEEDED');
  assert.match(task.assistantText, /Ответ 3$/);
  assert.ok((await api(`/api/tasks/${id}/state`)).state.messageCount >= 6);
  assert.equal((await api('/api/tasks')).length, 1);
  // The next restart uses the native session file (including the new turn).
  await fixture.restart();
  await api(`/api/tasks/${id}/message`, { text: 'after second restart' });
  task = await terminal(api, id);
  assert.match(task.assistantText, /Ответ 4$/);
  const resumedEvents = await api(`/api/tasks/${id}/events?limit=0`);
  const lastSeq = resumedEvents.at(-1).seq;
  assert.deepEqual(await api(`/api/tasks/${id}/events?limit=0&after=${lastSeq}`), []);
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/tasks/${id}/stream?after=0`, { headers: { 'Last-Event-ID': String(lastSeq - 1) }, signal: controller.signal });
  const reader = stream.body.getReader();
  let received = '';
  while (!received.includes('\ndata:')) received += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  const replay = received.split('\n').filter(x => x.startsWith('data:')).map(x => JSON.parse(x.slice(5)));
  assert.deepEqual(replay.map(x => x.seq), [lastSeq]);
  await assert.rejects(api(`/api/tasks/${id}/message`, { text: 'reject' }), /Fixture rejected/);
  assert.equal((await api(`/api/tasks/${id}/events?limit=0`)).filter(x => x.type === 'USER_MESSAGE').length, 3);
  await api(`/api/tasks/${id}/auto-compaction`, { enabled: false });
  assert.equal((await api(`/api/tasks/${id}`)).autoCompactionEnabled, false);
  // The fixture project runs without a worktree, so both git actions must be refused.
  const info = await api('/api/info');
  assert.equal(info.engine.configured, false);
  await assert.rejects(api(`/api/tasks/${id}/apply`, {}), /worktree/);
  await assert.rejects(api(`/api/tasks/${id}/worktree`, undefined, 'DELETE'), /worktree/);
  await api(`/api/tasks/${id}/compact`, {});
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal((await api(`/api/tasks/${id}`)).compaction.count, 1);
  await api(`/api/tasks/${id}/message`, { text: 'slow' });
  await api(`/api/tasks/${id}/cancel`, {});
  task = await terminal(api, id);
  assert.equal(task.status, 'CANCELLED');
  const cancelledEvents = await api(`/api/tasks/${id}/events?limit=0`);
  assert.equal(cancelledEvents.filter(x => x.type === 'TASK_CANCELLED').length, 1);
  // A failed model response must never be reported as successful verification.
  await api(`/api/tasks/${id}/message`, { text: 'model-error' });
  task = await terminal(api, id);
  assert.equal(task.status, 'FAILED');
  assert.equal(task.errorCode, 'MODEL_ERROR');
  await api(`/api/tasks/${id}`, undefined, 'DELETE');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal((await api('/api/tasks')).length, 0);
});

test('/debug/cloud reports a disabled transport and local mode keeps working', { timeout: 20000 }, async t => {
  const fixture = await startFixture(undefined, { root: { cloud: { enabled: true, url: 'not-a-url' } } });
  t.after(() => fixture.close());
  const status = await fixture.api('/debug/cloud');
  assert.equal(status.enabled, false);
  assert.match(status.reason.join(' '), /TASKBRIDGE_CLOUD_URL/);
  // Local-only behaviour is untouched by a misconfigured cloud transport.
  const created = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'local only' });
  const task = await terminal(fixture.api, created.id);
  assert.equal(task.status, 'SUCCEEDED', fixture.logs());
});

// The original way in — a phone or laptop in the same Wi-Fi hitting the PC's
// LAN address — must keep working regardless of the cloud transport
// (§2.1 "Сохраняются … LAN", §4 acceptance "LAN работает при выключенном
// облаке"). The merged cloud work must not have taken this path down.
test('LAN access keeps working while the cloud is off', { timeout: 30000 }, async t => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .find(iface => iface && iface.family === 'IPv4' && !iface.internal);
  if (!lan) return t.skip('this machine has no LAN interface');

  const fixture = await startFixture(undefined, { server: { host: '0.0.0.0' } });
  t.after(() => fixture.close());
  const port = new URL(fixture.base).port;
  const base = `http://${lan.address}:${port}`;

  // The UI itself is served over the LAN address, not just loopback.
  const info = await (await fetch(`${base}/api/info`)).json();
  assert.ok(info.addresses.some(entry => entry.url.includes(`:${port}`)), JSON.stringify(info.addresses));

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>/i);

  // A whole task can be created and finished from the LAN address.
  const created = await (await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'fixture', prompt: 'LAN check' })
  })).json();
  assert.ok(created.id, JSON.stringify(created));
  let task = null;
  for (let i = 0; i < 150; i++) {
    task = await (await fetch(`${base}/api/tasks/${created.id}`)).json();
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(task.status, 'SUCCEEDED', fixture.logs());

  // Cloud is off in this fixture: LAN must not depend on it.
  assert.equal((await (await fetch(`${base}/debug/cloud`)).json()).enabled, false);
});

test('native Pi session importer: list, preview, and a copy-based import over HTTP', { timeout: 30000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api, root } = fixture;

  // A terminal Pi session for the fixture project, in one of the scan roots.
  const sessions = path.join(root, 'data', 'pi-sessions');
  await fs.mkdir(sessions, { recursive: true });
  const header = { type: 'session', version: 3, id: 'native-http', timestamp: '2026-09-09T10:00:00.000Z', cwd: root };
  const entries = [
    { type: 'message', id: 'a', parentId: null, timestamp: header.timestamp, message: { role: 'user', content: [{ type: 'text', text: 'Терминальная сессия' }] } },
    { type: 'message', id: 'b', parentId: 'a', timestamp: header.timestamp, message: { role: 'assistant', model: 'qwen3.8-27b', provider: 'llamacpp', usage: { totalTokens: 1234 }, content: [{ type: 'text', text: 'Ответ ассистента' }] } },
    { type: 'thinking_level_change', id: 'c', parentId: 'b', timestamp: header.timestamp, thinkingLevel: 'high' }
  ];
  const body = [header, ...entries].map(entry => JSON.stringify(entry)).join('\n') + '\n';
  const file = path.join(sessions, 'terminal.jsonl');
  await fs.writeFile(file, body);

  const groups = await api('/api/native-sessions');
  const group = groups.find(item => item.id === 'fixture');
  assert.ok(group, JSON.stringify(groups));
  assert.equal(group.sessions.length, 1);
  const session = group.sessions[0];

  const preview = await api(`/api/native-sessions/preview?projectId=fixture&key=${session.key}`);
  assert.equal(preview.name, 'terminal');
  assert.deepEqual(preview.model, { provider: 'llamacpp', id: 'qwen3.8-27b' });
  assert.equal(preview.thinkingLevel, 'high');
  assert.equal(preview.tokens, 1234);
  assert.equal(preview.lastAssistant, 'Ответ ассистента');
  assert.equal(preview.existingTaskId, null);

  // Import copies by default: no confirmation flag is needed and the terminal
  // file is left exactly as it was.
  const created = await api('/api/tasks/from-session', { projectId: 'fixture', sessionKey: session.key });
  assert.ok(created.id, JSON.stringify(created));
  assert.equal(created.status, 'SUCCEEDED');
  assert.equal(created.nativeSource.mode, 'clone');
  assert.equal(await fs.readFile(file, 'utf8'), body);
  assert.notEqual(created.piSessionFile, await fs.realpath(file));
  assert.equal(await fs.readFile(created.piSessionFile, 'utf8'), body);

  // Follow-up continues the imported conversation instead of failing on a
  // missing or foreign session file.
  const task = await terminal(api, created.id);
  assert.equal(task.status, 'SUCCEEDED', fixture.logs());
  assert.ok((await api(`/api/tasks/${created.id}/events?limit=0`)).some(event => event.type === 'USER_MESSAGE'));

  // The list now reports it as already open, so the UI can offer "Открыть".
  const relisted = (await api('/api/native-sessions')).find(item => item.id === 'fixture');
  assert.equal(relisted.sessions[0].existingTaskId, created.id);
  assert.equal(relisted.suggestion, null, 'an imported session is not suggested again');
});

test('a session address opens the app shell itself, reload-safe, without breaking API 404s', { timeout: 20000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  // /session/<id> is a client route, not a file: the shell must be returned so a
  // reload, a bookmark or a phone link reaches the same session.
  for (const path of ['/session/abc123', '/session/abc123/']) {
    const page = await fetch(fixture.base + path);
    assert.equal(page.status, 200, path);
    assert.match(page.headers.get('content-type') || '', /text\/html/);
    assert.match(await page.text(), /<title>/i);
  }

  // File-like paths and unknown API routes must not silently become HTML.
  assert.equal((await fetch(`${fixture.base}/favicon.ico`)).status, 404);
  const apiMissing = await fetch(`${fixture.base}/api/nope`);
  assert.equal(apiMissing.status, 404);
  assert.match(apiMissing.headers.get('content-type') || '', /application\/json/);
});
