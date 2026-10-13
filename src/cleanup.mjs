// Cleanup manager (PROC-04/05, docs/TASKBRIDGE_RESOURCE_CLEANUP_PLAN.md):
// a batch cleanup goes through a preview plan first. The plan is a server-side
// snapshot with a short TTL; execute revalidates every candidate against a
// fresh process list (identity + protection, including tree descendants via
// killProcess) and reports a per-process result instead of one big success.
// Recommendations are a deterministic policy over the fresh snapshot — never
// an LLM decision, and estimated RAM is "accounted footprint", not a promise.

import { randomUUID } from 'node:crypto';
import { listProcesses, listGpuProcesses, gpuSummary, systemRam } from './process-info.mjs';
import { killProcess, findProtection } from './process-kill.mjs';

const PLAN_TTL_MS = 60_000;
const HISTORY_LIMIT = 50;

/** planId → plan; commandId → result (for idempotent retries); fifo history. */
const plans = new Map();
const resultsByCommand = new Map();
const history = [];

function prunePlans() {
  const now = Date.now();
  for (const [id, plan] of plans) if (plan.expiresAt < now) plans.delete(id);
}

/** True when the process belongs to a runtime family (shared with the UI filters). */
const RUNTIME_NAMES = {
  node: new Set(['node', 'nodejs']),
  python: new Set(['python', 'python3', 'py']),
  java: new Set(['java', 'javaw', 'javac', 'jshell']),
};

function baseName(entry) {
  return String(entry.name || entry.commandLine?.trim().split(/\s+/)[0] || '')
    .toLowerCase().replace(/\.exe$/, '').split(/[\\/]/).pop();
}

/**
 * Deterministic candidate ranking for an objective. Never includes protected
 * processes; estimated bytes are the accounted working set, not a promise.
 */
export function rankCandidates(list, { objective = 'ram', gpuPids = new Set(), exclude = new Set() } = {}) {
  const candidates = [];
  const skipped = [];
  for (const entry of list) {
    if (entry.pid === process.pid || exclude.has(entry.pid)) continue;
    const reason = findProtection(entry);
    if (reason) {
      skipped.push({ pid: entry.pid, name: entry.name, reason: 'protected' });
      continue;
    }
    const runtime = Object.entries(RUNTIME_NAMES).find(([, names]) => names.has(baseName(entry)))?.[0] ?? null;
    const gpu = gpuPids.has(entry.pid);
    // RAM objective: account every non-protected process. GPU objective: GPU
    // processes and known runtimes first — browsers/LLM runtimes eat VRAM.
    const relevant = objective === 'gpu' ? (gpu || runtime !== null) : true;
    candidates.push({
      pid: entry.pid,
      name: entry.name,
      memoryBytes: entry.memoryBytes,
      startedAt: entry.startedAt,
      runtime,
      usesGpu: gpu,
      score: (entry.memoryBytes ?? 0) + (gpu ? 512 * 1024 * 1024 : 0),
      _relevant: relevant,
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return { candidates, skipped };
}

/**
 * Build a preview plan. `pids` restricts to an explicit selection; otherwise
 * the top `limit` ranked candidates for the objective are proposed.
 */
export async function createCleanupPreview({ objective = 'ram', pids = null, limit = 30, targetFreeRamBytes = null } = {}) {
  prunePlans();
  const list = await listProcesses({ fresh: true });
  if (!list) throw Object.assign(new Error('Не удалось получить список процессов.'), { code: 'SNAPSHOT_UNAVAILABLE' });
  const gpuPids = new Set((await listGpuProcesses())?.map(p => p.pid) ?? []);
  const byPid = new Map(list.map(entry => [entry.pid, entry]));
  const requested = Array.isArray(pids) ? pids.map(Number).filter(pid => byPid.has(pid)) : null;
  const { candidates, skipped } = rankCandidates(list, { objective, gpuPids });
  const chosen = requested
    ? requested.map(pid => byPid.get(pid))
    : candidates.filter(entry => entry._relevant).slice(0, Math.max(1, limit)).map(entry => byPid.get(entry.pid));
  const estimatedRamBytes = chosen.reduce((sum, entry) => sum + (entry.memoryBytes ?? 0), 0);
  const availableRamBytes = systemRam().freeBytes;
  const warnings = [];
  if (objective === 'gpu') {
    warnings.push('Per-process VRAM под Windows WDDM недостоверна — фактический эффект измеряется по глобальной занятой VRAM после очистки.');
  }
  warnings.push(`Суммарное учтённое потребление кандидатов — ${estimatedRamBytes} байт; фактическое освобождение будет измерено после завершения.`);
  if (targetFreeRamBytes != null && availableRamBytes < targetFreeRamBytes) {
    warnings.push(`Доступно ${availableRamBytes} байт RAM, цель — ${targetFreeRamBytes}; этой очистки может не хватить.`);
  }
  const plan = {
    planId: randomUUID(),
    objective,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + PLAN_TTL_MS,
    snapshotRevision: list.length,
    candidates: chosen.map(({ _relevant, score, ...rest }) => ({ ...rest })),
    protectedSkipped: skipped,
    warnings,
    estimatedRamBytes,
  };
  plans.set(plan.planId, plan);
  return plan;
}

/**
 * Execute a confirmed plan. commandId is idempotent: a repeat returns the same
 * result without touching any process again.
 */
export async function executeCleanup({ planId, commandId, confirm = false } = {}) {
  if (typeof planId !== 'string' || !planId) {
    throw Object.assign(new Error('Нужен planId из /api/system/cleanup/preview.'), { code: 'INPUT_INVALID' });
  }
  if (typeof commandId !== 'string' || !commandId) {
    throw Object.assign(new Error('Нужен уникальный commandId — повторный вызов с тем же commandId не убивает второй раз.'), { code: 'INPUT_INVALID' });
  }
  if (confirm !== true) {
    throw Object.assign(new Error('Массовая остановка требует confirm: true.'), { code: 'CONFIRM_REQUIRED' });
  }
  if (resultsByCommand.has(commandId)) return { ...resultsByCommand.get(commandId), idempotent: true };
  prunePlans();
  const plan = plans.get(planId);
  if (!plan) {
    throw Object.assign(new Error('План не найден или истёк — снимите новый предпросмотр.'), { code: 'PLAN_NOT_FOUND' });
  }
  if (plan.expiresAt < Date.now()) {
    plans.delete(planId);
    throw Object.assign(new Error('Срок плана истёк — снимите новый предпросмотр.'), { code: 'PLAN_EXPIRED' });
  }
  plans.delete(planId);

  const ramBefore = systemRam();
  const gpuBefore = await gpuSummary();
  const items = [];
  for (const candidate of plan.candidates) {
    let status = 'FAILED';
    let detail = null;
    try {
      await killProcess({ pid: candidate.pid, name: candidate.name ?? '' });
      status = 'STOPPED';
    } catch (error) {
      if (error.code === 'NOT_FOUND') status = 'ALREADY_EXITED';
      else if (error.code === 'PROTECTED') { status = 'PROTECTED'; detail = error.message; }
      else if (error.code === 'NAME_MISMATCH') { status = 'IDENTITY_CHANGED'; detail = error.message; }
      else detail = error.message;
    }
    items.push({ pid: candidate.pid, name: candidate.name, status, ...(detail ? { detail } : {}) });
  }
  const ramAfter = systemRam();
  const gpuAfter = await gpuSummary();
  const result = {
    planId,
    commandId,
    finishedAt: new Date().toISOString(),
    items,
    stopped: items.filter(item => item.status === 'STOPPED').length,
    protectedCount: items.filter(item => item.status === 'PROTECTED').length,
    failedCount: items.filter(item => item.status === 'FAILED' || item.status === 'IDENTITY_CHANGED').length,
    ram: {
      freeBeforeBytes: ramBefore.freeBytes,
      freeAfterBytes: ramAfter.freeBytes,
      observedDeltaBytes: ramAfter.freeBytes - ramBefore.freeBytes,
    },
    gpu: (gpuBefore && gpuAfter && gpuBefore.gpus[0] && gpuAfter.gpus[0]) ? {
      usedBeforeMb: gpuBefore.gpus[0].vramUsedMb,
      usedAfterMb: gpuAfter.gpus[0].vramUsedMb,
      sampledAt: gpuAfter.sampledAt,
    } : null,
  };
  resultsByCommand.set(commandId, result);
  history.push({ at: result.finishedAt, objective: plan.objective, planId, commandId, stopped: result.stopped, protectedCount: result.protectedCount, failedCount: result.failedCount });
  if (history.length > HISTORY_LIMIT) history.shift();
  if (resultsByCommand.size > HISTORY_LIMIT * 2) {
    for (const key of resultsByCommand.keys()) { resultsByCommand.delete(key); if (resultsByCommand.size <= HISTORY_LIMIT) break; }
  }
  return result;
}

export function getCleanupResultByCommand(commandId) {
  return resultsByCommand.get(commandId) ?? null;
}

export function cleanupHistory() {
  return [...history];
}
