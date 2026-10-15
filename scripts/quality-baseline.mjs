#!/usr/bin/env node
// Disposable fake-Pi baseline. Never connects to the operator's running server.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../tests/server-fixture.mjs';
import { TaskStore } from '../src/task-store.mjs';
import { percentile } from '../src/metrics.mjs';

const args = process.argv.slice(2);
const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const samples = Number(value('--samples') || 20);
if (!Number.isInteger(samples) || samples < 2 || samples > 100) throw new Error('--samples must be 2..100');
const repo = fileURLToPath(new URL('..', import.meta.url));
const summary = values => ({ samples: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), maxMs: Math.max(...values) });
const fixture = await startFixture(undefined, {
  // The disposable copy runs with --expose-gc so the probe can measure retained
  // heap (post-GC), not just peaks. Only this fixture child sees the flag;
  // NODE_OPTIONS does not forward --expose-gc, hence the explicit nodeArgs.
  nodeArgs: ['--expose-gc'],
});
// Instrument only the disposable copy. CPU/heap/event-loop figures must come
// from the server process, not from this HTTP load generator.
const probeFile = path.join(fixture.root, 'quality-process.json');
// Post-GC heap per completed turn; filled while the load loop runs.
const retainedAfterTurn = [];
// The probe file is rewritten every 100 ms and the write is not atomic, so a
// torn read is retried rather than fatal.
const readProbe = async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    try { return JSON.parse(await fs.readFile(probeFile, 'utf8')); }
    catch { await new Promise(resolve => setTimeout(resolve, 60)); }
  }
  throw new Error('Probe file never parsed');
};
const settled = async id => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const task = await fixture.api(`/api/tasks/${id}`);
    if (task.status === 'SUCCEEDED') return;
    if (['FAILED', 'CANCELLED'].includes(task.status)) throw new Error(`Fixture turn ${task.status}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Fixture did not settle');
};
const replayFirstEvent = async (id, cursor) => {
  const start = performance.now();
  const response = await fetch(`${fixture.base}/api/tasks/${id}/stream?after=${cursor}`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`SSE replay HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) throw new Error('SSE ended before replay');
      buffer += decoder.decode(next.value, { stream: true });
      const frame = /^data: ([^\r\n]+)\r?\n/m.exec(buffer);
      if (!frame) continue;
      if (!(JSON.parse(frame[1]).seq > cursor)) throw new Error('SSE replay did not advance its cursor');
      return performance.now() - start;
    }
  } finally { await reader.cancel(); }
};
try {
  await fs.appendFile(path.join(fixture.root, 'src/server.mjs'), `
const qualityPerf = await import('node:perf_hooks');
const qualityFs = await import('node:fs');
const qualityLoop = qualityPerf.monitorEventLoopDelay({ resolution: 10 });
qualityLoop.enable();
const qualityCpuStart = process.cpuUsage();
const qualityAt = performance.now();
let qualityPeakRss = 0, qualityPeakHeap = 0;
setInterval(() => {
  // Two collections back-to-back: the first sweeps the current space, the
  // second settles promoted survivors — a close enough retained-heap read.
  if (typeof globalThis.gc === 'function') { globalThis.gc(); globalThis.gc(); }
  const memory = process.memoryUsage();
  qualityPeakRss = Math.max(qualityPeakRss, memory.rss);
  qualityPeakHeap = Math.max(qualityPeakHeap, memory.heapUsed);
  qualityFs.writeFileSync(${JSON.stringify(probeFile)}, JSON.stringify({
    pid: process.pid, elapsedMs: performance.now() - qualityAt,
    cpuMicros: process.cpuUsage(qualityCpuStart), memory,
    retainedHeapBytes: typeof globalThis.gc === 'function' ? memory.heapUsed : null,
    sampledPeakRssBytes: qualityPeakRss, sampledPeakHeapBytes: qualityPeakHeap,
    eventLoopDelay: { p50Ms: qualityLoop.percentile(50) / 1e6, p95Ms: qualityLoop.percentile(95) / 1e6, p99Ms: qualityLoop.percentile(99) / 1e6, maxMs: qualityLoop.max / 1e6 }
  }));
}, 100).unref();
`);
  await fixture.restart();
  const task = await fixture.api('/api/tasks', { projectId: 'fixture', prompt: 'quality baseline' });
  await settled(task.id);
  const ack = [], dedupe = [], history = [];
  for (let i = 0; i < samples; i++) {
    const body = { text: `baseline ${i}`, commandId: `quality-${i}`, clientId: 'quality-baseline' };
    let start = performance.now();
    await fixture.api(`/api/tasks/${task.id}/message`, body);
    ack.push(performance.now() - start);
    start = performance.now();
    await fixture.api(`/api/tasks/${task.id}/message`, body);
    dedupe.push(performance.now() - start);
    await settled(task.id);
    // Post-GC heap after this turn: a short wait guarantees a sample newer
    // than the turn's end.
    const probeAt = (await readProbe()).elapsedMs;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 120));
      const probe = await readProbe();
      if (probe.elapsedMs > probeAt && probe.retainedHeapBytes != null) { retainedAfterTurn.push(probe.retainedHeapBytes); break; }
    }
    start = performance.now();
    await fixture.api(`/api/tasks/${task.id}/events?limit=100`);
    history.push(performance.now() - start);
  }
  const events = await fixture.api(`/api/tasks/${task.id}/events?limit=0`);
  const commands = events.filter(event => event.type === 'USER_MESSAGE' && event.data?.clientId === 'quality-baseline');
  if (commands.length !== samples) throw new Error('Duplicate command effects in baseline');
  const store = new TaskStore(path.join(fixture.root, 'data'));
  let queryPlan;
  try {
    queryPlan = store.db.prepare('EXPLAIN QUERY PLAN SELECT payload FROM events WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(task.id, 0, 100).map(row => row.detail);
  } finally { store.close(); }
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'web', 'clients/kmp/core/client/src', 'clients/kmp/shared/src'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(file => /\.(mjs|js|kt)$/.test(file) && !file.includes('/vendor/'));
  const sizes = await Promise.all(files.map(async file => ({ path: file, bytes: (await fs.stat(path.join(repo, file))).size })));
  const processProfile = await readProbe();
  if (processProfile.pid !== fixture.appPid) throw new Error('Profile belongs to a different process');
  const restart = [], replay = [];
  const replayCursor = events[Math.floor(events.length / 2)].seq;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    await fixture.restart();
    restart.push(performance.now() - start);
    replay.push(await replayFirstEvent(task.id, replayCursor));
  }
  const report = {
    schemaVersion: 1, at: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repo, encoding: 'utf8' }).trim()),
    environment: { platform: process.platform, arch: process.arch, node: process.version, os: os.release() },
    runtime: 'disposable fake Pi; warm local HTTP; not production/model latency',
    commandAck: summary(ack), duplicateAck: summary(dedupe), history100Events: summary(history),
    confirmedCommandEffects: commands.length, sqliteEventReplayPlan: queryPlan,
    serverProcess: processProfile,
    retainedHeap: retainedAfterTurn.length >= 2 ? {
      samples: retainedAfterTurn.length,
      firstMB: +(retainedAfterTurn[0] / 1048576).toFixed(2),
      lastMB: +(retainedAfterTurn[retainedAfterTurn.length - 1] / 1048576).toFixed(2),
      maxMB: +(Math.max(...retainedAfterTurn) / 1048576).toFixed(2),
      growthPerTurnKB: +((retainedAfterTurn[retainedAfterTurn.length - 1] - retainedAfterTurn[0]) / (retainedAfterTurn.length - 1) / 1024).toFixed(2),
      note: 'post-GC heapUsed sampled after each settled turn in the disposable server (--expose-gc only there)',
    } : { samples: retainedAfterTurn.length, note: 'no retained samples; fixture child ran without gc()' },
    restartToReady: summary(restart), sseFirstReplayAfterRestart: summary(replay),
    profilingNote: '10ms event-loop histogram; CPU since warm probe start; memory peaks sampled every 100ms with periodic local JSON write overhead; retained heap is reported separately from post-GC samples',
    largestSources: sizes.sort((a, b) => b.bytes - a.bytes).slice(0, 20)
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (value('--output')) await fs.writeFile(path.resolve(value('--output')), json);
  else process.stdout.write(json);
} finally { await fixture.close(); }
