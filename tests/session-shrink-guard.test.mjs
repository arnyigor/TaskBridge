import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';
import { DEFAULT_SESSION_MAX_MB } from '../src/session-shrink.mjs';

// A provider refuses the request body by size (~50 MB at api.deepseek.com,
// measured 2026-10-19), while Pi's own protection is token-based. A session
// carrying screenshots therefore dies with 413 and can never start again. The
// guard shrinks such a transcript before Pi opens it — this test proves the
// wiring (event, file on disk, Pi starts) with a real server and a fake Pi.

const ACTIVE = ['QUEUED', 'PREPARING', 'PREFLIGHT', 'RUNNING', 'VERIFYING', 'CANCELLING'];

async function settle(api, id, { tries = 200, delay = 50 } = {}) {
  let task;
  for (let i = 0; i < tries; i++) {
    task = await api(`/api/tasks/${id}`);
    if (!ACTIVE.includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error(`task stayed ${task.status}`);
}

const sessionHeader = JSON.stringify({ type: 'session', version: 1, id: 'fixture-session' });
const userLine = text => JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } });
const imageLine = (id, bytes) => JSON.stringify({
  type: 'message',
  message: {
    role: 'toolResult',
    toolCallId: `call_${id}`,
    toolName: 'read',
    content: [
      { type: 'text', text: 'Read image file [image/png]' },
      { type: 'image', data: 'A'.repeat(bytes) }
    ]
  }
});

test('a session over the byte budget is shrunk before Pi starts it', { timeout: 90000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'first turn' });
  const id = created.id;
  assert.equal((await settle(api, id)).status, 'SUCCEEDED');

  // Retire the live Pi (a session's own Pi holds the transcript in memory), then
  // put a deliberately oversized transcript where Pi will read it from.
  await api(`/api/tasks/${id}/session/restart`, {});
  const dir = path.join(fixture.root, 'data', 'pi-sessions', id);
  await fs.mkdir(dir, { recursive: true });
  const existing = (await fs.readdir(dir)).filter(name => name.endsWith('.jsonl'));
  assert.ok(existing.length <= 1, 'at most one session file for the task');
  const file = path.join(dir, existing[0] || '2026-01-01T00-00-00-000Z_fixture.jsonl');
  const oversized = [
    sessionHeader,
    userLine('start'),
    imageLine('a', 9 * 1024 * 1024),
    imageLine('b', 9 * 1024 * 1024),
    imageLine('c', 9 * 1024 * 1024)
  ].join('\n');
  await fs.writeFile(file, `${oversized}\n`);
  const before = (await fs.stat(file)).size;
  assert.ok(before > DEFAULT_SESSION_MAX_MB * 1024 * 1024, `fixture transcript is over the budget (${before} bytes)`);

  await api(`/api/tasks/${id}/message`, { text: 'second turn' });
  const finished = await settle(api, id);
  assert.equal(finished.status, 'SUCCEEDED', finished.error || '');

  const after = (await fs.stat(file)).size;
  assert.ok(after < DEFAULT_SESSION_MAX_MB * 1024 * 1024, `transcript shrank to ${after} bytes`);

  const events = await api(`/api/tasks/${id}/events?limit=0`);
  const shrunk = events.filter(event => event.type === 'SESSION_SHRUNK');
  assert.equal(shrunk.length, 1, 'the operator is told the context was restored');
  assert.match(shrunk[0].message, /Контекст сессии восстановлен/i);
  assert.match(shrunk[0].message, /Оригиналы сохранены/);
  assert.ok(shrunk[0].data?.beforeBytes > shrunk[0].data?.afterBytes);

  // The fake Pi really loaded the shrunk file: its own record of the transcript
  // is what it appended, and the operator text above the images is still there.
  const text = await fs.readFile(file, 'utf8');
  assert.match(text, /"text":"start"/);
  assert.equal((text.match(/скриншот исключён/g) || []).length, 1, 'only the oldest of the three images was replaced');

  // Originals are kept outside the transcript, content-addressed, and the
  // placeholder points at them — the screenshot is not lost, only unsent.
  const artifacts = await fs.readdir(path.join(fixture.root, 'data', 'media'));
  assert.equal(artifacts.length, 1, 'one original on disk');
  assert.match(artifacts[0], /^[0-9a-f]{64}\.png$/);
  // The placeholder carries the absolute path: Pi's read resolves it outside the
  // session's working directory, a bare "data/media/..." would resolve against
  // the workspace and miss.
  const artifactPath = path.join(fixture.root, 'data', 'media', artifacts[0]);
  const notices = text.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .flatMap(record => (Array.isArray(record?.message?.content) ? record.message.content : []))
    .filter(part => part.type === 'text' && part.text.includes('оригинал:'));
  assert.equal(notices.length, 1);
  assert.ok(notices[0].text.includes(artifactPath), `placeholder names the original: ${notices[0].text}`);
  assert.ok(await fs.stat(artifactPath).then(() => true, () => false), 'the artifact really exists');
  assert.equal(shrunk[0].data?.dropped, 1);
});

test('a text-only session over the budget is reported, not rewritten', { timeout: 90000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'first turn' });
  const id = created.id;
  assert.equal((await settle(api, id)).status, 'SUCCEEDED');
  await api(`/api/tasks/${id}/session/restart`, {});
  const dir = path.join(fixture.root, 'data', 'pi-sessions', id);
  await fs.mkdir(dir, { recursive: true });
  const existing = (await fs.readdir(dir)).filter(name => name.endsWith('.jsonl'));
  const file = path.join(dir, existing[0] || '2026-01-01T00-00-00-000Z_fixture.jsonl');
  const big = [sessionHeader, userLine('x'.repeat(DEFAULT_SESSION_MAX_MB * 1024 * 1024 + 4096))].join('\n');
  await fs.writeFile(file, `${big}\n`);

  await api(`/api/tasks/${id}/message`, { text: 'second turn' });
  const finished = await settle(api, id);
  assert.equal(finished.status, 'SUCCEEDED', finished.error || '');

  const events = await api(`/api/tasks/${id}/events?limit=0`);
  const tooLarge = events.filter(event => event.type === 'SESSION_TOO_LARGE');
  assert.equal(tooLarge.length, 1, 'no images left: say so instead of editing text silently');
  assert.match(tooLarge[0].message, /уменьшать нечего|сжатия текста/i);
  // Pi appended its own turn to the same file; the operator's line is untouched.
  const after = await fs.readFile(file, 'utf8');
  assert.ok(after.startsWith(big), 'the operator text is untouched');
});

test('a 413 mid-turn repairs the session and re-runs the turn once', { timeout: 90000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const { api } = fixture;
  const created = await api('/api/tasks', { projectId: 'fixture', prompt: 'first turn' });
  const id = created.id;
  assert.equal((await settle(api, id)).status, 'SUCCEEDED');
  // The first turn ran without a session file (the fake reports none), so the
  // task gets one now: Pi will start on it, and the fake appends the screenshots.
  await api(`/api/tasks/${id}/session/restart`, {});
  const dir = path.join(fixture.root, 'data', 'pi-sessions', id);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, '2026-01-01T00-00-00-000Z_fixture.jsonl');
  await fs.writeFile(file, `${[sessionHeader, userLine('start')].join('\n')}\n`);
  assert.ok((await fs.stat(file)).size < DEFAULT_SESSION_MAX_MB * 1024 * 1024, 'under the budget before the turn');

  // The fake grows the transcript by three screenshots (like a real Blender turn)
  // and then answers 413 — exactly the sequence that used to hang forever.
  const prompt = 'fault-provider-incompatible body-limit structured';
  await api(`/api/tasks/${id}/message`, { text: prompt });
  const failed = await settle(api, id);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.errorCode, 'REQUEST_TOO_LARGE');

  // The repair is verified, and the interrupted turn runs again on its own: the
  // continuation prompt is answered, the operator's text is not re-sent.
  let resumed = failed;
  for (let i = 0; i < 200 && resumed.status !== 'SUCCEEDED'; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    resumed = await api(`/api/tasks/${id}`);
  }
  assert.equal(resumed.status, 'SUCCEEDED', resumed.error || '');

  const events = await api(`/api/tasks/${id}/events?limit=0`);
  assert.equal(events.filter(event => event.type === 'SESSION_SHRUNK').length, 1, 'one repair, no loop');
  assert.match(events.find(event => event.type === 'SESSION_SHRUNK').message, /Контекст сессии восстановлен/);
  assert.equal(events.filter(event => event.type === 'USER_MESSAGE' && event.message === prompt).length, 1, 'the operator message is not duplicated');
  assert.equal(events.filter(event => event.type === 'USER_MESSAGE').length, 1, 'nothing but the operator message — the recovery is a continuation, not a resend');

  assert.ok((await fs.stat(file)).size < DEFAULT_SESSION_MAX_MB * 1024 * 1024, 'the repaired transcript is under the budget');
  const artifacts = await fs.readdir(path.join(fixture.root, 'data', 'media'));
  assert.equal(artifacts.length, 1, 'the three identical screenshots are stored once, by content');
});

test('the media policy really reaches the Pi that TaskBridge spawns', { timeout: 60000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-args-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const dump = path.join(dir, 'spawn.json');
  const fixture = await startFixture(0, { env: { FAKE_PI_DUMP_ARGS: dump } });
  t.after(() => fixture.close());
  const created = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'hello' });
  await settle(fixture.api, created.id);

  const spawned = JSON.parse(await fs.readFile(dump, 'utf8'));
  const extensionIndex = spawned.argv.indexOf('-e');
  assert.ok(extensionIndex >= 0, `Pi got -e: ${spawned.argv.join(' ')}`);
  assert.ok(spawned.argv[extensionIndex + 1].endsWith(path.join('pi-extension', 'taskbridge-media.js')),
    `Pi got the media extension: ${spawned.argv[extensionIndex + 1]}`);
  assert.equal(spawned.env.TASKBRIDGE_MEDIA_KEEP_IMAGES, '2');
  assert.equal(spawned.env.TASKBRIDGE_MEDIA_IMAGE_BUDGET_MB, '2');
  assert.equal(spawned.env.TASKBRIDGE_MEDIA_REQUEST_BUDGET_MB, '40');
});
