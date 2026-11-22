import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readWatchdogState, recordWatchdogCheck, recoveryBackoffMs, watchdogStateForInfo } from '../src/watchdog-state.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tb-watchdog-state-'));

test('watchdog state records checks, errors and successful recoveries', () => {
  const dir = temp();
  try {
    recordWatchdogCheck(dir, { healthy: true, status: 200, bootId: 'boot-1', storeId: 'store-1' });
    let state = readWatchdogState(dir);
    assert.equal(state.healthy, true);
    assert.equal(state.bootId, 'boot-1');
    assert.equal(state.storeId, 'store-1');
    assert.equal(state.lastError, null);
    assert.ok(state.lastCheckAt);
    assert.ok(state.lastHealthyAt);

    const recoveredBefore = state.lastRecoveryAt ?? null;
    recordWatchdogCheck(dir, { healthy: false, status: 502, error: 'health HTTP 502' });
    state = readWatchdogState(dir);
    assert.equal(state.healthy, false);
    assert.equal(state.lastError, 'health HTTP 502');
    assert.equal(state.lastRecoveryAt ?? null, recoveredBefore, 'a failed tick must not move lastRecoveryAt');

    recordWatchdogCheck(dir, { healthy: true, status: 200, bootId: 'boot-2', storeId: 'store-1', recovered: true });
    state = readWatchdogState(dir);
    assert.equal(state.bootId, 'boot-2');
    assert.ok(state.lastRecoveryAt, 'a successful recovery must be recorded');
    assert.equal(state.lastError, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale watchdog file is visible as stale in /api/info', () => {
  const dir = temp();
  try {
    recordWatchdogCheck(dir, { healthy: true, status: 200 });
    const now = Date.now();
    assert.equal(watchdogStateForInfo(dir, { now, maxAgeMs: 60_000 }).stale, false);
    assert.equal(watchdogStateForInfo(dir, { now: now + 120_000, maxAgeMs: 60_000 }).stale, true);
    assert.equal(watchdogStateForInfo(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-empty-'))), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repeated failures back off and preserve the cause', () => {
  const dir = temp();
  try {
    assert.equal(recoveryBackoffMs(1), 3 * 60 * 1000);
    assert.equal(recoveryBackoffMs(2), 6 * 60 * 1000);
    assert.equal(recoveryBackoffMs(5), 30 * 60 * 1000, 'backoff must cap at 30 minutes');

    recordWatchdogCheck(dir, { healthy: false, status: 502, error: 'first failure', consecutiveFailures: 1, nextRetryAt: new Date(Date.now() + 180_000).toISOString() });
    let state = readWatchdogState(dir);
    assert.equal(state.consecutiveFailures, 1);
    assert.ok(state.nextRetryAt);
    const retryAt = state.nextRetryAt;

    // A skipped tick (backoff) must not reset the counter or lose the error.
    recordWatchdogCheck(dir, { healthy: false, skipped: 'backoff', error: 'first failure' });
    state = readWatchdogState(dir);
    assert.equal(state.consecutiveFailures, 1);
    assert.equal(state.nextRetryAt, retryAt);
    assert.equal(state.lastError, 'first failure');

    // A successful probe clears both the counter and the retry time.
    recordWatchdogCheck(dir, { healthy: true, status: 200 });
    state = readWatchdogState(dir);
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(state.nextRetryAt, null);
    assert.equal(state.lastError, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
