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

// Generation window of one assistant message: from its first streamed delta to
// the message_end. Idle time inside that window IS generation time — a slow
// local engine emits one chunk every few seconds, and a tool call happens
// BETWEEN messages, never inside one. The previous version summed only gaps of
// at most 2 s and silently dropped the rest: for a Strata session that reported
// 50.4 tok/s where the server's own counter said 36.7 (2026-09-29, iq3_xxs log:
// 1054 generated in 28726 ms), and 100 tok/s in another turn.
export function generationWindowMs(firstDeltaAt, endAt) {
  const first = Number(firstDeltaAt);
  const end = Number(endAt);
  if (!Number.isFinite(first) || !Number.isFinite(end) || first <= 0 || end <= first) return 0;
  return end - first;
}

// Output tokens over the time the model actually spent streaming them.
export function computeTokensPerSecond(outputTokens, ms) {
  const tokens = Number(outputTokens);
  const duration = Number(ms);
  if (!Number.isFinite(tokens) || !Number.isFinite(duration) || tokens <= 0 || duration <= 0) return null;
  return tokens / (duration / 1000);
}

/**
 * Speed figures for one assistant message.
 *
 * TG = output tokens / the message's own generation window. `usage.output` is the
 * provider's count of every generated token, thinking included — verified on all
 * 4384 assistant messages in data/tasks: totalTokens = input + cacheRead +
 * output, so reasoning tokens are a subset of output and dividing by the whole
 * window (not by the answer-text part) is what matches the engine.
 *
 * PP = tokens prefilled / time to the first token, and only for providers that
 * do NOT serve the prompt from their own cache: a local engine keeps the prompt
 * in its KV cache and prefills just the new tail (Strata 2026-09-29: "prompt
 * 82996 tokens = 82643 reused + 353 read in 1982 ms"), so tokens/TTFT claimed
 * 32 895 tok/s where the honest figure was 178. Nothing to report there without
 * the engine's own counter — `null`, never an invented number.
 */
export function generationMetrics({ usage, promptMs, windowMs, engine, local } = {}) {
  const input = Number(usage?.input) || 0;
  const cached = Number(usage?.cacheRead) || 0;
  const output = Number(usage?.output) || 0;
  // Cache hits are not prefill work even for a remote provider, so they are left
  // out of the rate while still counting towards the prompt size.
  const estimatedPp = local ? null : computeTokensPerSecond(input, promptMs);
  const enginePp = Number(engine?.pp);
  const engineTg = Number(engine?.tg);
  const pp = Number.isFinite(enginePp) && enginePp > 0 ? enginePp : estimatedPp;
  const tg = Number.isFinite(engineTg) && engineTg > 0 ? engineTg : computeTokensPerSecond(output, windowMs);
  if (pp == null && tg == null) return null;
  const ppSource = pp == null ? null : (pp === enginePp ? (engine?.source || 'engine') : 'ttft-estimate');
  const tgSource = tg === engineTg ? (engine?.source || 'engine') : 'usage';
  return {
    pp,
    tg,
    inputTokens: input + cached || null,
    outputTokens: output || null,
    promptMs: Number(promptMs) || null,
    ms: Number(windowMs) || null,
    // 'mixed' only when both halves came from sources that disagree.
    source: ppSource == null ? tgSource : (ppSource === tgSource ? ppSource : 'mixed'),
    ppSource,
    tgSource,
    ppApproximate: ppSource === 'ttft-estimate'
  };
}
