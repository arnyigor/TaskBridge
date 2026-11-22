import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { buildStagingEnv } from '../scripts/staging-launch.mjs';

const tmp = os.tmpdir();
const safe = { PATH: 'x', TEMP: tmp, SYSTEMROOT: 'C:\\Windows' };
const production = { ...safe, TASKBRIDGE_PORT: '55482', TASKBRIDGE_DATA_DIR: 'G:/prod/data', TASKBRIDGE_MACHINE_SECRET: 's' };

// REL-01C-A: staging must be fail-closed. A shell that still carries production
// wiring refuses to launch BEFORE any server, store or Pi process exists.
test('staging refuses a parent environment with production wiring', () => {
  const plan = buildStagingEnv(production, { dataDir: path.join(tmp, 'stage'), port: 59991 });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /TASKBRIDGE_PORT/);
  assert.match(plan.reason, /TASKBRIDGE_DATA_DIR/);
});

test('staging refuses missing dataDir/port and repo-overlapping dataDir', () => {
  assert.equal(buildStagingEnv(safe, { port: 59991 }).ok, false);
  assert.equal(buildStagingEnv(safe, { dataDir: path.join(tmp, 'stage') }).ok, false);
  const inRepo = buildStagingEnv(safe, { dataDir: path.resolve('.local/staging'), port: 59991 });
  assert.equal(inRepo.ok, false, 'the staging tree must not sit inside the production checkout');
});

test('a clean parent yields an allowlisted child env with explicit staging values', () => {
  const dataDir = path.join(tmp, 'taskbridge-staging-launcher-check');
  const plan = buildStagingEnv(safe, { dataDir, port: 59992 });
  assert.equal(plan.ok, true);
  assert.equal(plan.env.TASKBRIDGE_PORT, '59992');
  assert.equal(plan.env.TASKBRIDGE_DATA_DIR, path.resolve(dataDir));
  assert.equal(plan.env.TASKBRIDGE_PROJECT_MEMORY_ROOT, path.join(path.resolve(dataDir), 'memory-md'));
  // Nothing production-shaped may pass through, even keys we did not list.
  assert.equal('TASKBRIDGE_MACHINE_SECRET' in plan.env, false);
  assert.equal('TASKBRIDGE_PUBLIC_PORT' in plan.env, false);
});
