import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// PC state for the UI ("is the machine the reason the model is slow?"). Every
// reader is best-effort: a field that cannot be read stays null and the UI shows
// "—" instead of a made-up zero (same rule as the model metrics, TZ v3 §13).

// ---------------------------------------------------------------------------
// CPU
// ---------------------------------------------------------------------------

// os.loadavg() is useless on Windows (always [0, 0, 0]), so the load is derived
// from the delta of the per-core tick counters between two calls. That needs one
// previous sample: the first call primes it and reports load=null.
export function cpuLoadFromSamples(previous, current) {
  if (!Array.isArray(previous) || !Array.isArray(current) || previous.length !== current.length || !current.length) return null;
  let idle = 0;
  let total = 0;
  for (let i = 0; i < current.length; i += 1) {
    idle += current[i].idle - previous[i].idle;
    total += current[i].total - previous[i].total;
  }
  if (total <= 0) return null;
  return Math.max(0, Math.min(1, 1 - idle / total));
}

const cpuSample = () => os.cpus().map((cpu) => {
  const t = cpu.times;
  return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
});

let lastCpuSample = null;

export function readCpuLoad() {
  const sample = cpuSample();
  const cores = sample.length;
  if (!cores) return null;
  const load = cpuLoadFromSamples(lastCpuSample, sample);
  lastCpuSample = sample;
  return { load, cores };
}

// ---------------------------------------------------------------------------
// RAM
// ---------------------------------------------------------------------------

export function readRam() {
  const total = os.totalmem();
  if (!(total > 0)) return null;
  const used = total - os.freemem();
  return { used, total, ratio: used / total };
}

// ---------------------------------------------------------------------------
// GPU (NVIDIA via nvidia-smi; absent everywhere else)
// ---------------------------------------------------------------------------

export function parseNvidiaSmi(output) {
  const rows = String(output || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const num = (value) => {
    const parsed = Number(String(value).trim());
    return Number.isFinite(parsed) ? parsed : null;
  };
  const gpus = [];
  for (const row of rows) {
    const cols = row.split(',').map(x => x.trim());
    if (cols.length < 7) continue;
    gpus.push({
      name: cols[0] || null,
      memoryUsedMb: num(cols[1]),
      memoryTotalMb: num(cols[2]),
      utilization: num(cols[3]),
      powerDrawW: num(cols[4]),
      powerLimitW: num(cols[5]),
      temperatureC: num(cols[6])
    });
  }
  return gpus.length ? gpus : null;
}

const GPU_QUERY = 'name,memory.used,memory.total,utilization.gpu,power.draw,power.limit,temperature.gpu';

let gpuCache = { at: 0, value: null };

// nvidia-smi is a process spawn (~50-150 ms), and the UI polls every few
// seconds, so the result is cached briefly. Not finding the binary is normal
// (AMD/Intel/macOS/no driver) and must not surface as an error.
export async function readGpuMetrics({ timeoutMs = 1500, cacheMs = 3000 } = {}) {
  if (Date.now() - gpuCache.at < cacheMs) return gpuCache.value;
  let value = null;
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [`--query-gpu=${GPU_QUERY}`, '--format=csv,noheader,nounits'], { timeout: timeoutMs, windowsHide: true });
    value = parseNvidiaSmi(stdout);
  } catch {
    value = null;
  }
  gpuCache = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export async function readSystemMetrics({ gpu = true } = {}) {
  const gpus = gpu ? await readGpuMetrics() : null;
  return {
    sampledAt: new Date().toISOString(),
    cpu: readCpuLoad(),
    ram: readRam(),
    gpu: gpus && gpus.length ? gpus : null
  };
}

// Adds the gap between two deltas to the streaming time, but only when the gap
// is short enough to be generation: a long pause between deltas is tool
// execution, and counting it would report a token rate far below the real one.
export function accumulateStreamMs(previousAt, at, accumulated, maxGapMs = 2000) {
  const total = Number(accumulated) || 0;
  if (!previousAt || !at || at <= previousAt || at - previousAt > maxGapMs) return total;
  return total + (at - previousAt);
}

// Output tokens over the time the model actually spent streaming them.
export function computeTokensPerSecond(outputTokens, ms) {
  const tokens = Number(outputTokens);
  const duration = Number(ms);
  if (!Number.isFinite(tokens) || !Number.isFinite(duration) || tokens <= 0 || duration <= 0) return null;
  return tokens / (duration / 1000);
}
