import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startFixture } from './server-fixture.mjs';

const exec = promisify(execFile);

// MEM-01 over real HTTP: the project memory inspector is READ-ONLY, bounded, and
// never a second source of truth. These checks are about the edges the unit tests
// cannot see — authorization, query shape and the guarantee that inspecting memory
// does not touch it.

function request(base, route, { method = 'GET', headers = {} } = {}) {
  const url = new URL(route, base);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function gitRepo(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-memory-api-repo-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const who = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
  await exec('git', ['init', '-q'], { cwd: dir });
  await exec('git', [...who, 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

async function snapshot(dir) {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    const stat = await fs.stat(full);
    files.push(`${path.relative(dir, full)}:${stat.size}:${stat.mtimeMs}`);
  }
  return files.sort();
}

test('the memory inspector answers over the local API and never writes to the memory directory', { timeout: 60000 }, async t => {
  const repo = await gitRepo(t);
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-memory-api-root-'));
  t.after(() => fs.rm(memoryRoot, { recursive: true, force: true }));
  const core = path.join(memoryRoot, path.basename(repo), 'core', 'project');
  await fs.mkdir(core, { recursive: true });
  await fs.writeFile(path.join(core, 'cursor.md'), '---\ndescription: "Cursor policy"\ntags: [constraint]\n---\nEvent cursor must remain monotonic.\n', 'utf8');
  await fs.writeFile(path.join(core, 'worktree.md'), '---\ndescription: "Worktree policy"\n---\nMissing worktree must never fall back to main.\n', 'utf8');
  // A note OUTSIDE the project's core folder: reachable on disk, never injected by
  // pi-memory-md and never returned by the inspector.
  await fs.writeFile(path.join(memoryRoot, 'secret.md'), 'not project memory\n', 'utf8');

  const fixture = await startFixture(undefined, { root: { memory: { projectMemoryRoot: memoryRoot } } });
  t.after(() => fixture.close());
  const project = await fixture.api('/api/projects/local-register', { path: repo, name: 'Memory API' });
  const before = await snapshot(memoryRoot);

  const overview = await fixture.api(`/api/projects/${project.id}/memory`);
  assert.equal(overview.provider, 'pi-memory-md');
  assert.equal(overview.status, 'available');
  assert.equal(overview.write, 'SAVE_DISABLED', 'чтение не превращается в запись');
  assert.equal(overview.injectedAutomatically, true);
  assert.equal(overview.entries, 2);
  assert.ok(overview.approxTokens > 0);
  assert.deepEqual(overview.collisions, [], 'одна память — один репозиторий');
  assert.equal(overview.hits, undefined, 'без q список записей не отдаётся целиком');

  const found = await fixture.api(`/api/projects/${project.id}/memory?q=${encodeURIComponent('event cursor')}`);
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0].source, 'core/project/cursor.md', 'источник — путь относительно папки проекта в памяти');
  assert.equal(found.hits[0].category, 'constraint');
  assert.match(found.hits[0].text, /monotonic/);

  // Query shape: empty, huge, unicode, quotes and a path-looking value are inputs,
  // not paths — none may crash or reach outside the memory directory.
  for (const query of ['', '   ', 'x'.repeat(5000), 'курсор', '"cursor" AND (worktree)', '../../../../etc/passwd', '\\..\\..\\secrets']) {
    const response = await request(fixture.base, `/api/projects/${project.id}/memory?q=${encodeURIComponent(query)}`);
    assert.equal(response.status, 200, `q=${JSON.stringify(query.slice(0, 30))} → ${response.status}`);
    assert.ok(Array.isArray(response.data.hits), 'ответ всегда со списком результатов');
    assert.ok(response.data.hits.length <= 20, 'выдача ограничена');
  }
  // A cleared search box is the most common state: it lists entries, bounded,
  // instead of answering in a different shape.
  const empty = await fixture.api(`/api/projects/${project.id}/memory?q=`);
  assert.equal(empty.hits.length, 2);
  // A file outside the project's memory folder is never reachable through a query.
  const escaping = await fixture.api(`/api/projects/${project.id}/memory?q=${encodeURIComponent('not project memory')}`);
  assert.deepEqual(escaping.hits.map(hit => hit.source), [], 'сканируется только core проекта');

  // Unknown project is a 404-shaped refusal, not an empty success.
  assert.equal((await request(fixture.base, '/api/projects/nope/memory')).status, 404);
  // There is no write path at all. A POST without a JSON body is stopped by the
  // global rule that every mutating request declares its content type, and a
  // well-formed one reaches the router and finds no route — neither can write.
  assert.equal((await request(fixture.base, `/api/projects/${project.id}/memory`, { method: 'POST' })).status, 400);
  assert.equal((await request(fixture.base, `/api/projects/${project.id}/memory`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
  })).status, 404);

  assert.deepEqual(await snapshot(memoryRoot), before, 'инспекция ничего не записала в память');
});

test('the memory inspector follows the same authorization as every other project route', { timeout: 60000 }, async t => {
  const fixture = await startFixture(undefined, { server: { auth: { enabled: true, allowedOrigins: [] } } });
  t.after(() => fixture.close());
  const [project] = await fixture.api('/api/projects');
  const route = `/api/projects/${project.id}/memory`;

  // A remote caller without a paired device token sees nothing — memory contains
  // the project's internal decisions, which is exactly what must not leak.
  const remote = { 'x-forwarded-for': '100.101.102.103' };
  assert.equal((await request(fixture.base, route, { headers: remote })).status, 401);
  assert.equal((await request(fixture.base, `${route}?q=worktree`, { headers: remote })).status, 401);
  // The machine itself (loopback) keeps access.
  assert.equal((await request(fixture.base, route)).status, 200);
});
