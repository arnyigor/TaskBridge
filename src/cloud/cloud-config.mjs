import crypto from 'node:crypto';
import os from 'node:os';

// Cloud transport configuration (§11, §90). Environment variables win over
// config.json so a deployment can keep secrets out of the repository.

const DEFAULTS = {
  enabled: false,
  url: '',
  machineId: '',
  machineSecret: '',
  machineDisplayName: '',
  authMode: 'bearer', // 'bearer' | 'hmac'
  realtime: false,
  relayUrl: '',        // derived from url when empty: wss://<host>/api/relay
  protocolVersion: 1,
  eventFlushMs: 75,
  eventBatchMax: 100,
  eventBatchMaxKb: 256,
  heartbeatSeconds: 20,
  idlePollSeconds: 5,
  activePollSeconds: 1,
  maxRetryDelayMs: 30000,
  requestTimeoutMs: 20000,
  maxOutboxMb: 100,
  redactPaths: true,
  coalesceDeltas: true,
  toolOutput: { rollingKb: 64, tailKb: 64, snapshotMs: 500, maxFullMb: 4 },
  logLevel: 'info'
};

function bool(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function num(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

// Stable, non-identifying default machine id (§10). Derived from the data
// directory path hash, so it never exposes the user name, hostname or an
// absolute path.
export function defaultMachineId(seed) {
  const hash = crypto.createHash('sha256').update(String(seed || os.hostname())).digest('hex');
  return `machine-${hash.slice(0, 12)}`;
}

export function resolveCloudConfig(config = {}, env = process.env, { dataRoot = '' } = {}) {
  const cloud = config.cloud || {};
  const resolved = {
    ...DEFAULTS,
    ...cloud,
    enabled: bool(env.TASKBRIDGE_CLOUD_ENABLED ?? cloud.enabled, DEFAULTS.enabled),
    url: String(env.TASKBRIDGE_CLOUD_URL ?? cloud.url ?? '').replace(/\/+$/, ''),
    machineId: String(env.TASKBRIDGE_MACHINE_ID ?? cloud.machineId ?? '').trim(),
    machineSecret: String(env.TASKBRIDGE_MACHINE_SECRET ?? cloud.machineSecret ?? ''),
    machineDisplayName: String(env.TASKBRIDGE_MACHINE_NAME ?? cloud.machineDisplayName ?? '').trim(),
    authMode: String(env.TASKBRIDGE_CLOUD_AUTH_MODE ?? cloud.authMode ?? DEFAULTS.authMode).toLowerCase(),
    realtime: bool(env.TASKBRIDGE_CLOUD_REALTIME ?? cloud.realtime, DEFAULTS.realtime),
    relayUrl: String(env.TASKBRIDGE_RELAY_URL ?? cloud.relayUrl ?? '').trim(),
    eventFlushMs: num(env.TASKBRIDGE_EVENT_FLUSH_MS ?? cloud.eventFlushMs, DEFAULTS.eventFlushMs, { min: 10, max: 5000 }),
    eventBatchMax: num(env.TASKBRIDGE_EVENT_BATCH_MAX ?? cloud.eventBatchMax, DEFAULTS.eventBatchMax, { min: 1, max: 10000 }),
    eventBatchMaxKb: num(env.TASKBRIDGE_EVENT_BATCH_MAX_KB ?? cloud.eventBatchMaxKb, DEFAULTS.eventBatchMaxKb, { min: 8, max: 8192 }),
    heartbeatSeconds: num(env.TASKBRIDGE_HEARTBEAT_SECONDS ?? cloud.heartbeatSeconds, DEFAULTS.heartbeatSeconds, { min: 5, max: 3600 }),
    idlePollSeconds: num(env.TASKBRIDGE_IDLE_POLL_SECONDS ?? cloud.idlePollSeconds, DEFAULTS.idlePollSeconds, { min: 0.2, max: 600 }),
    activePollSeconds: num(env.TASKBRIDGE_ACTIVE_POLL_SECONDS ?? cloud.activePollSeconds, DEFAULTS.activePollSeconds, { min: 0.1, max: 600 }),
    maxRetryDelayMs: num(env.TASKBRIDGE_MAX_RETRY_DELAY_MS ?? cloud.maxRetryDelayMs, DEFAULTS.maxRetryDelayMs, { min: 1000, max: 3600000 }),
    requestTimeoutMs: num(env.TASKBRIDGE_CLOUD_TIMEOUT_MS ?? cloud.requestTimeoutMs, DEFAULTS.requestTimeoutMs, { min: 1000, max: 300000 }),
    maxOutboxMb: num(env.TASKBRIDGE_MAX_OUTBOX_MB ?? cloud.maxOutboxMb, DEFAULTS.maxOutboxMb, { min: 1, max: 10240 }),
    redactPaths: bool(env.TASKBRIDGE_CLOUD_REDACT_PATHS ?? cloud.redactPaths, DEFAULTS.redactPaths),
    coalesceDeltas: bool(env.TASKBRIDGE_COALESCE_DELTAS ?? cloud.coalesceDeltas, DEFAULTS.coalesceDeltas),
    // Tool output bounding (§38): wire window and the cap for an explicit
    // "load full output" request.
    toolOutput: {
      rollingKb: num(env.TASKBRIDGE_TOOL_OUTPUT_ROLLING_KB ?? cloud.toolOutput?.rollingKb, DEFAULTS.toolOutput.rollingKb, { min: 4, max: 4096 }),
      tailKb: num(env.TASKBRIDGE_TOOL_OUTPUT_TAIL_KB ?? cloud.toolOutput?.tailKb, DEFAULTS.toolOutput.tailKb, { min: 4, max: 4096 }),
      snapshotMs: num(env.TASKBRIDGE_TOOL_OUTPUT_SNAPSHOT_MS ?? cloud.toolOutput?.snapshotMs, DEFAULTS.toolOutput.snapshotMs, { min: 100, max: 10000 }),
      maxFullMb: num(env.TASKBRIDGE_TOOL_OUTPUT_MAX_MB ?? cloud.toolOutput?.maxFullMb, DEFAULTS.toolOutput.maxFullMb, { min: 0.1, max: 32 })
    },
    logLevel: String(env.TASKBRIDGE_CLOUD_LOG_LEVEL ?? cloud.logLevel ?? DEFAULTS.logLevel).toLowerCase()
  };
  if (!resolved.machineId) resolved.machineId = defaultMachineId(dataRoot);
  // The relay lives on the same deployment as the cloud API, so the default
  // needs no second setting — and the phone derives the very same address from
  // the page it was served (web/cloud-config.js).
  if (!resolved.relayUrl && resolved.url) resolved.relayUrl = `${resolved.url.replace(/^http/i, 'ws')}/api/relay`;
  if (!['bearer', 'hmac'].includes(resolved.authMode)) resolved.authMode = 'bearer';
  return resolved;
}

// Fails fast with an actionable message instead of silently running without a
// transport the operator asked for.
export function validateCloudConfig(cfg) {
  const problems = [];
  if (!cfg.enabled) return { ok: true, problems };
  if (!/^https?:\/\//i.test(cfg.url)) problems.push('TASKBRIDGE_CLOUD_URL must be an absolute http(s) URL');
  if (!cfg.machineId) problems.push('TASKBRIDGE_MACHINE_ID (or a machine id in config.json) is required');
  if (!cfg.machineSecret) problems.push('TASKBRIDGE_MACHINE_SECRET is required');
  if (cfg.machineSecret && cfg.machineSecret.length < 16) problems.push('TASKBRIDGE_MACHINE_SECRET must be at least 16 characters');
  return { ok: problems.length === 0, problems };
}
