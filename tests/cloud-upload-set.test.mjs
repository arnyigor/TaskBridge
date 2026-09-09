import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  auditUploadSet,
  collectUploadCandidates,
  formatAudit,
  parseIgnoreFile,
  SENSITIVE_LOCAL_FILES
} from '../cloud/lib/upload-set.mjs';
import { findSensitivePaths, isSensitivePath, matchesIgnore } from '../cloud/lib/deploy.mjs';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-secrets.mjs');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-secrets-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function write(root, relative, content = 'x') {
  const absolute = path.join(root, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, 'utf8');
}

async function git(root, args) {
  return execFileAsync('git', args, { cwd: root });
}

test('parseIgnoreFile drops comments and normalizes separators', () => {
  // trailing slashes are normalized away (matchesIgnore still treats it as a directory)
  assert.deepEqual(parseIgnoreFile(['# c', '', 'config.json', 'data/'].join(String.fromCharCode(13, 10))), ['config.json', 'data']);
  assert.deepEqual(parseIgnoreFile('cloud\\data'), ['cloud/data']);
  assert.deepEqual(parseIgnoreFile(null), []);
});

test('matchesIgnore handles exact paths, directories and globs', () => {
  assert.equal(matchesIgnore('config.json', ['config.json']), true);
  assert.equal(matchesIgnore('config.json', ['data/']), false);
  assert.equal(matchesIgnore('data/tasks/1.db', ['data/']), true);
  assert.equal(matchesIgnore('data', ['data/']), true);
  assert.equal(matchesIgnore('config.json.bak-123', ['config.json.bak-*']), true);
  assert.equal(matchesIgnore('src/server.mjs', ['config.json.bak-*']), false);
  assert.equal(matchesIgnore('cloud/data/x.db', ['cloud/data/']), true);
});

test('isSensitivePath classifies secrets, state and metadata', () => {
  assert.equal(isSensitivePath('config.json'), 'local config (machine secret)');
  assert.equal(isSensitivePath('config.json.bak-1'), 'local config (machine secret)');
  assert.equal(isSensitivePath('.env.local'), 'env files');
  assert.equal(isSensitivePath('data/tasks.db'), 'local task data');
  assert.equal(isSensitivePath('cloud/data/taskbridge-cloud.db'), 'cloud database');
  assert.equal(isSensitivePath('artifacts/tool-1.log'), 'artifacts (full tool logs)');
  assert.equal(isSensitivePath('storage/tasks.sqlite-wal'), 'local database file');
  assert.equal(isSensitivePath('deploy/id_rsa'), 'key material');
  assert.equal(isSensitivePath('cert/server.pem'), 'key material');
  assert.equal(isSensitivePath('cloud/lib/store.mjs'), null);
  assert.equal(isSensitivePath(''), null);
  assert.deepEqual(findSensitivePaths(['src/a.mjs', 'config.json']), [{ path: 'config.json', rule: 'local config (machine secret)' }]);
});

test('collectUploadCandidates walks the tree, skipping ignored paths and node_modules', async t => {
  const root = await tempDir(t);
  await write(root, 'src/server.mjs');
  await write(root, 'cloud/web/app.js');
  await write(root, 'config.json', '{"cloud":{}}');
  await write(root, 'data/tasks.db');
  await write(root, 'node_modules/pg/index.js');
  await write(root, 'notes.log');

  const candidates = await collectUploadCandidates({ root, ignoreLines: ['config.json', 'data/', '*.log'] });
  assert.deepEqual(candidates, ['cloud/web/app.js', 'src/server.mjs']);
});

test('auditUploadSet catches a missing or incomplete .vercelignore', async t => {
  const root = await tempDir(t);
  await write(root, 'src/server.mjs');
  await write(root, 'config.json', '{"cloud":{"machineSecret":"tb_machine_fixture"}}');
  await write(root, 'data/tasks.db');
  await write(root, 'cloud/data/cloud.db');

  const leaky = await auditUploadSet({ root, vercelIgnoreText: null });
  assert.equal(leaky.ok, false);
  assert.deepEqual(leaky.findings.map(finding => finding.path), ['cloud/data/cloud.db', 'config.json', 'data/tasks.db']);
  assert.deepEqual(leaky.coverage.missing, ['config.json', 'data/', 'cloud/data/']);

  const partial = await auditUploadSet({ root, vercelIgnoreText: 'config.json\n' });
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.findings.map(finding => finding.path), ['cloud/data/cloud.db', 'data/tasks.db']);

  const fixed = await auditUploadSet({ root, vercelIgnoreText: 'config.json\ndata/\ncloud/data/\n' });
  assert.equal(fixed.ok, true);
  assert.deepEqual(fixed.findings, []);
  assert.match(formatAudit(fixed), /no sensitive path in the upload set/);
});

test('the repository itself passes the upload-set audit', async () => {
  const audit = await auditUploadSet({ root: REPO_ROOT, vercelIgnoreText: await fs.readFile(path.join(REPO_ROOT, '.vercelignore'), 'utf8') });
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.findings, []);
  assert.ok(audit.candidates.includes('cloud/lib/router.mjs'), 'cloud code must be uploaded');
  assert.ok(audit.candidates.includes('src/domain/task-event.mjs'), 'shared protocol code must be uploaded');
  assert.ok(!audit.candidates.includes('config.json'));
  assert.ok(!audit.candidates.some(candidate => candidate.startsWith('data/')));
});

test('every sensitive local path is covered by .gitignore', async () => {
  const gitignore = parseIgnoreFile(await fs.readFile(path.join(REPO_ROOT, '.gitignore'), 'utf8'));
  for (const { path: relative, probe } of SENSITIVE_LOCAL_FILES) {
    if (relative === 'artifacts') continue; // optional directory, created on demand
    assert.equal(matchesIgnore(probe, gitignore), true, `${relative} must be ignored by .gitignore`);
  }
});

test('check-secrets exits 0 on this repository', async () => {
  const { stdout } = await execFileAsync(process.execPath, [SCRIPT], { cwd: REPO_ROOT });
  assert.match(stdout, /no secret would leave this machine/);
});

test('check-secrets fails on a fixture where a secret is committed and uploadable', async t => {
  const root = await tempDir(t);
  await write(root, '.gitignore', 'data/*\n');
  await write(root, 'src/server.mjs');
  await write(root, 'config.json', JSON.stringify({ cloud: { machineSecret: 'tb_machine_LEAKED_VALUE_1234567890ABCDEFGH' } }));
  await write(root, 'data/tasks.db');
  await write(root, 'notes.md', 'token: tb_machine_LEAKED_VALUE_1234567890ABCDEFGH\n');
  await write(root, 'deploy/id_rsa', 'private');

  await git(root, ['init', '-q']);
  await git(root, ['add', '-A', '-f']);
  // config.json is force-added on purpose: that is the leak the audit must catch.
  await git(root, ['add', '-f', 'config.json']);

  const failure = await execFileAsync(process.execPath, [SCRIPT, '--root', root]).then(
    () => null,
    error => error
  );
  assert.ok(failure, 'the audit must fail on this fixture');
  assert.equal(failure.code, 1);
  const output = `${failure.stdout}${failure.stderr}`;
  assert.match(output, /vercel upload would include config\.json/);
  assert.match(output, /vercel upload would include data\/tasks\.db/);
  assert.match(output, /vercel upload would include deploy\/id_rsa/);
  assert.match(output, /tracked file contains a machine secret/);
  assert.match(output, /\.gitignore/);
  // The audit must never print the secret itself.
  assert.ok(!output.includes('tb_machine_LEAKED_VALUE_1234567890ABCDEFGH'), 'the audit must not echo the secret');
});

test('check-secrets passes a fixture where everything is excluded', async t => {
  const root = await tempDir(t);
  await write(root, '.gitignore', 'config.json\ndata/\ncloud/data/\n');
  await write(root, '.vercelignore', 'config.json\ndata/\ncloud/data/\n');
  await write(root, 'src/server.mjs');
  await write(root, 'config.json', JSON.stringify({ cloud: { machineSecret: 'tb_machine_FIXTURE_VALUE_1234567890' } }));
  await write(root, 'data/tasks.db');

  await git(root, ['init', '-q']);

  const { stdout } = await execFileAsync(process.execPath, [SCRIPT, '--root', root]);
  assert.match(stdout, /no secret would leave this machine/);
});
