import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Incident 2026-11-22: restart-lan-now.mjs referenced an undefined `ROOT` while
// checking TASKBRIDGE_DATA_DIR. A restart of an isolated instance (the documented
// safe way to test next to production) died with ReferenceError before it could
// refuse, and no restart report was written. The production default data dir hid
// the bug because `&&` short-circuited before the undefined name.
const root = fileURLToPath(new URL('..', import.meta.url));

test('restart worker with an isolated TASKBRIDGE_DATA_DIR fails safely, not with ReferenceError', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-restart-data-'));
  try {
    const result = spawnSync(process.execPath, ['scripts/restart-lan-now.mjs', '--dry-run'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, TASKBRIDGE_DATA_DIR: data, LAN_PORT: '19999' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dry-run:/);
    assert.doesNotMatch(result.stderr, /ReferenceError|ROOT is not defined/);
    assert.deepEqual(fs.readdirSync(data).filter(name => name === 'lan-restart.lock'), []);
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});
