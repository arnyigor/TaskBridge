import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// S1: a recovery loop must stop hammering. When watchdog-state says the next
// retry is in the future, `ensure` probes once but does not start anything.
const root = fileURLToPath(new URL('..', import.meta.url));
const enabled = process.platform === 'win32';
const gate = enabled ? test : test.skip;

async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

gate('ensure honors the recovery backoff instead of retrying forever', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-backoff-'));
  try {
    const port = await freePort();
    const retryAt = new Date(Date.now() + 10 * 60_000).toISOString();
    fs.writeFileSync(path.join(dir, 'watchdog-state.json'), JSON.stringify({
      lastCheckAt: new Date().toISOString(),
      healthy: false,
      status: 502,
      consecutiveFailures: 3,
      nextRetryAt: retryAt,
      lastError: 'previous recovery failed',
    }, null, 2));

    const result = spawnSync(process.execPath, ['bin/taskbridge.mjs', 'ensure'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        TASKBRIDGE_DATA_DIR: dir,
        LAN_PORT: String(port),
        LAN_HOST: '127.0.0.1',
        LAN_TLS: 'off',
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const state = JSON.parse(fs.readFileSync(path.join(dir, 'watchdog-state.json'), 'utf8'));
    assert.equal(state.skipped, 'backoff');
    assert.equal(state.consecutiveFailures, 3, 'backoff skip must preserve the counter');
    assert.equal(state.nextRetryAt, retryAt, 'backoff skip must preserve the retry time');
    assert.equal(state.lastError, 'previous recovery failed');
    assert.equal(fs.existsSync(path.join(dir, 'lan.json')), false, 'backoff must not start a pair');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
