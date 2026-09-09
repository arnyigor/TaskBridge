import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCredentials, cloudEnvVars, randomToken } from '../cloud/lib/credentials.mjs';
import {
  buildDeployPlan,
  buildEnvVarCommands,
  buildLocalConfigPatch,
  classifyHealth,
  maskCommandArgs,
  maskSecret,
  mergeCloudConfig,
  nextSteps,
  parseDeployUrl,
  REQUIRED_ENV_VARS,
  REQUIRED_IGNORES,
  verifyVercelIgnore
} from '../cloud/lib/deploy.mjs';
import { resolveStoreTarget } from '../cloud/lib/store.mjs';

test('generateCredentials produces a matching machine record and cloud config', () => {
  const credentials = generateCredentials({ machineId: 'home-pc-01', machineName: 'Desk', ownerId: 'owner' });
  assert.match(credentials.userToken, /^tb_user_[A-Za-z0-9_-]{40,}$/);
  assert.match(credentials.machineSecret, /^tb_machine_[A-Za-z0-9_-]{40,}$/);
  assert.deepEqual(JSON.parse(credentials.machinesJson), [{ id: 'home-pc-01', secret: credentials.machineSecret, ownerId: 'owner', displayName: 'Desk' }]);
  assert.deepEqual(credentials.cloudConfig, { enabled: true, url: null, machineId: 'home-pc-01', machineSecret: credentials.machineSecret, machineDisplayName: 'Desk' });
});

test('generateCredentials validates ids and generates unique secrets', () => {
  assert.throws(() => generateCredentials({ machineId: 'bad id!' }), /Invalid machine id/);
  assert.throws(() => generateCredentials({ ownerId: 'bad/owner' }), /Invalid owner id/);
  const a = generateCredentials();
  const b = generateCredentials();
  assert.notEqual(a.userToken, b.userToken);
  assert.notEqual(a.machineSecret, b.machineSecret);
  assert.match(a.machineId, /^home-pc-[0-9a-f]{4}$/);
  assert.match(randomToken('x_'), /^x_[A-Za-z0-9_-]+$/);
});

test('cloudEnvVars carries exactly what the cloud function needs', () => {
  const credentials = generateCredentials({ machineId: 'm1', userEmail: 'me@example.com' });
  assert.deepEqual(Object.keys(cloudEnvVars(credentials)), ['TASKBRIDGE_CLOUD_USER_TOKEN', 'TASKBRIDGE_CLOUD_USER_ID', 'TASKBRIDGE_CLOUD_MACHINES', 'TASKBRIDGE_CLOUD_USER_EMAIL']);
  assert.equal(cloudEnvVars(credentials, { databaseUrl: 'postgres://x' }).POSTGRES_URL, 'postgres://x');
  assert.ok(!('url' in cloudEnvVars(credentials)), 'the cloud URL is a local setting, not a cloud env var');
  for (const name of REQUIRED_ENV_VARS) assert.ok(name in cloudEnvVars(credentials), `${name} must be set`);
});

test('buildDeployPlan refuses a deploy without a durable store', () => {
  const credentials = generateCredentials({ machineId: 'm1' });
  const blocked = buildDeployPlan({ projectName: 'tb', credentials });
  assert.equal(blocked.blockers.length, 1);
  assert.match(blocked.blockers[0], /No Postgres URL/);

  const allowed = buildDeployPlan({ projectName: 'tb', credentials, allowMemoryStore: true });
  assert.equal(allowed.blockers.length, 0);
  assert.match(allowed.warnings.join(' '), /in-memory store/);

  const withDb = buildDeployPlan({ projectName: 'tb', credentials, databaseUrl: 'postgres://user:pass@host/db' });
  assert.deepEqual(withDb.blockers, []);
  assert.deepEqual(withDb.warnings, []);
  assert.equal(withDb.envVars.POSTGRES_URL, 'postgres://user:pass@host/db');
  assert.ok(withDb.steps.some(step => step.id === 'env:POSTGRES_URL'));
});

test('buildDeployPlan orders link → env → deploy and never puts secrets on the command line', () => {
  const credentials = generateCredentials({ machineId: 'm1' });
  const plan = buildDeployPlan({ projectName: 'tb', credentials, databaseUrl: 'postgres://x', scope: 'team', token: 'vercel-tok' });
  assert.deepEqual(plan.steps.map(step => step.id), [
    'link',
    'env:TASKBRIDGE_CLOUD_USER_TOKEN',
    'env:TASKBRIDGE_CLOUD_USER_ID',
    'env:TASKBRIDGE_CLOUD_MACHINES',
    'env:POSTGRES_URL',
    'deploy'
  ]);
  assert.deepEqual(plan.steps[0].args, ['link', '--yes', '--project', 'tb', '--scope', 'team', '--token', 'vercel-tok']);
  assert.deepEqual(plan.steps.at(-1).args, ['deploy', '--prod', '--yes', '--scope', 'team', '--token', 'vercel-tok']);

  for (const step of plan.steps) {
    if (!step.stdin) continue;
    assert.equal(step.args.filter(arg => arg.includes(credentials.userToken) || arg.includes(credentials.machineSecret)).length, 0);
    assert.ok(step.stdin.trim().length > 0);
  }
});

test('buildDeployPlan blocks a missing project name', () => {
  const plan = buildDeployPlan({ credentials: generateCredentials({ machineId: 'm1' }), databaseUrl: 'postgres://x' });
  assert.match(plan.blockers.join(' '), /--project/);
});

test('buildEnvVarCommands targets the requested environment and overwrites', () => {
  const commands = buildEnvVarCommands({ A: '1', B: '2' }, { environment: 'preview' });
  assert.deepEqual(commands.map(command => command.args), [
    ['env', 'add', 'A', 'preview', '--force'],
    ['env', 'add', 'B', 'preview', '--force']
  ]);
  assert.equal(commands[0].stdin, '1\n');
});

test('maskSecret/maskCommandArgs keep secrets out of logs', () => {
  assert.equal(maskSecret('short'), '***');
  assert.match(maskSecret('tb_machine_abcdefghijklmnop'), /^tb_machi…mnop \(\d+ chars\)$/);
  const masked = maskCommandArgs(['env', 'add', 'POSTGRES_URL', 'production', 'postgres://u:p@h/db']);
  assert.equal(masked[4].includes('u:p'), false);
  assert.deepEqual(maskCommandArgs(['link', '--yes', '--project', 'tb']), ['link', '--yes', '--project', 'tb']);
});

test('parseDeployUrl picks the production URL from CLI output', () => {
  assert.equal(parseDeployUrl('Production: https://tb-abc123.vercel.app [2s]'), 'https://tb-abc123.vercel.app');
  assert.equal(parseDeployUrl('Inspect: https://vercel.com/x\nPreview: https://tb-git-main.vercel.app\nProduction: https://tb.vercel.app'), 'https://tb.vercel.app');
  assert.equal(parseDeployUrl('nothing here'), null);
});

test('classifyHealth detects the silent memory-store fallback', () => {
  assert.deepEqual(classifyHealth({ status: 'ok', store: 'postgres', durable: true }), { ok: true, durable: true, store: 'postgres', message: 'ok — store: postgres' });
  const memory = classifyHealth({ status: 'ok', store: 'memory', durable: false });
  assert.equal(memory.ok, true);
  assert.equal(memory.durable, false);
  assert.match(memory.message, /NOT durable/);
  // Older deployments do not report the field: memory must still be treated as unsafe.
  assert.equal(classifyHealth({ status: 'ok', store: 'memory' }).durable, false);
  assert.equal(classifyHealth({ status: 'ok', store: 'postgres' }).durable, true);
  assert.equal(classifyHealth({ status: 'ok' }).durable, false);
  assert.equal(classifyHealth(null).ok, false);
  assert.equal(classifyHealth({ status: 'down' }).ok, false);
});

test('buildLocalConfigPatch/mergeCloudConfig never clobber unrelated settings', () => {
  const credentials = generateCredentials({ machineId: 'm1' });
  const patch = buildLocalConfigPatch(credentials, 'https://tb.vercel.app');
  assert.deepEqual(patch.cloud, { enabled: true, url: 'https://tb.vercel.app', machineId: 'm1', machineSecret: credentials.machineSecret, machineDisplayName: credentials.machineName });
  const merged = mergeCloudConfig({ port: 8787, cloud: { enabled: false, url: 'http://old' } }, patch);
  assert.equal(merged.port, 8787);
  assert.equal(merged.cloud.url, 'https://tb.vercel.app');
  assert.equal(merged.cloud.enabled, true);
  assert.equal(mergeCloudConfig(null, patch).cloud.url, 'https://tb.vercel.app');
});

test('nextSteps mentions the token, the machine and /debug/cloud', () => {
  const lines = nextSteps({ url: 'https://tb.vercel.app', userToken: 'tb_user_x', machineId: 'm1' }).join('\n');
  assert.match(lines, /https:\/\/tb\.vercel\.app/);
  assert.match(lines, /tb_user_x/);
  assert.match(lines, /m1/);
  assert.match(lines, /debug\/cloud/);
});

test('verifyVercelIgnore requires local secrets and state to be excluded', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  // The repository must ship a .vercelignore that covers the local secrets and
  // state, because `vercel deploy` ignores .gitignore.
  const actual = await fs.readFile(path.join(root, '.vercelignore'), 'utf8');
  const checked = verifyVercelIgnore(actual);
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.missing, []);
  assert.ok(checked.lines.includes("config.json") && checked.lines.includes("data/"));
  const missing = verifyVercelIgnore(['config.json', '# comment', ''].join(String.fromCharCode(10)));
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['data/', 'cloud/data/']);
  assert.equal(verifyVercelIgnore(null).ok, false);
  assert.deepEqual(verifyVercelIgnore('').missing, REQUIRED_IGNORES);
});

test('a Vercel Postgres URL is what makes the store durable', () => {
  // The deploy script must set one of these, otherwise resolveStoreTarget()
  // falls back to memory and the health check reports durable: false.
  assert.equal(resolveStoreTarget({ POSTGRES_URL: 'postgres://x' }), 'postgres://x');
  assert.equal(classifyHealth({ status: 'ok', store: 'memory' }).durable, false);
});
