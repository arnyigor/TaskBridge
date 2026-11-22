// Durable state of the external watchdog (the Windows "TaskBridge" scheduled
// task). `taskbridge ensure` writes it on every tick; `/api/info` exposes it, so
// an operator can see whether the independent mechanism is actually alive.
//
// This file is deliberately separate from the server's own health: `lastCheckAt`
// proves the external mechanism ran, `lastRecoveryAt` proves it restarted a dead
// pair, and `lastError` explains a failed tick. A fresh `lastCheckAt` with
// `healthy: false` is not a success — that is the signal `LastTaskResult` alone
// could not give (2026-11-22: result 0 while the watchdog was inert).
import fs from 'node:fs';
import path from 'node:path';

export const WATCHDOG_STATE_FILE = 'watchdog-state.json';

/** Recovery retry: 3 min, 6, 12, 24, then cap 30 min. */
export function recoveryBackoffMs(consecutiveFailures) {
  const failures = Math.max(1, Number(consecutiveFailures) || 1);
  return Math.min(3 * 60 * 1000 * (2 ** (failures - 1)), 30 * 60 * 1000);
}

export function watchdogStatePath(dataRoot) {
  return path.join(dataRoot, WATCHDOG_STATE_FILE);
}

export function readWatchdogState(dataRoot) {
  try {
    const value = JSON.parse(fs.readFileSync(watchdogStatePath(dataRoot), 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function writeWatchdogState(dataRoot, state) {
  const file = watchdogStatePath(dataRoot);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows can refuse rename-over-existing for a file held by a reader.
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
  }
}

/**
 * Record one watchdog tick. Preserves identity/recovery fields from earlier
 * ticks; `recovered` only sets lastRecoveryAt when the probe is healthy too.
 */
export function recordWatchdogCheck(dataRoot, patch = {}) {
  const previous = readWatchdogState(dataRoot) || {};
  const at = new Date().toISOString();
  const healthy = patch.healthy === true;
  const skipped = Boolean(patch.skipped);
  const previousFailures = Number(previous.consecutiveFailures) || 0;
  const consecutiveFailures = healthy
    ? 0
    : skipped
      ? previousFailures
      : Number.isInteger(patch.consecutiveFailures)
        ? patch.consecutiveFailures
        : previousFailures + 1;
  const next = {
    ...previous,
    lastCheckAt: at,
    healthy,
    status: Number.isInteger(patch.status) ? patch.status : null,
    bootId: patch.bootId || null,
    storeId: patch.storeId || null,
    sseHealthy: typeof patch.sseHealthy === 'boolean' ? patch.sseHealthy : (previous.sseHealthy ?? null),
    consecutiveFailures,
    nextRetryAt: healthy
      ? null
      : (patch.nextRetryAt ?? (skipped ? (previous.nextRetryAt ?? null) : null)),
    lastError: patch.error
      ? String(patch.error)
      : (skipped ? (previous.lastError ?? null) : null),
  };
  if (healthy) next.lastHealthyAt = at;
  if (healthy && patch.recovered === true) next.lastRecoveryAt = at;
  if (patch.skipped) next.skipped = String(patch.skipped);
  else delete next.skipped;
  delete next.stale;
  writeWatchdogState(dataRoot, next);
  return next;
}

/** `/api/info` view: adds staleness so an old file is not mistaken for a live tick. */
export function watchdogStateForInfo(dataRoot, { now = Date.now(), maxAgeMs = 15 * 60 * 1000 } = {}) {
  const state = readWatchdogState(dataRoot);
  if (!state) return null;
  const checked = Date.parse(state.lastCheckAt);
  return {
    ...state,
    stale: !Number.isFinite(checked) || now - checked > maxAgeMs,
  };
}
