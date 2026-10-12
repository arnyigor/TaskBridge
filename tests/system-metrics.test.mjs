import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNvidiaSmi, cpuLoadFromSamples, readRam, computeTokensPerSecond, generationWindowMs, generationMetrics, accumulateSessionSpeeds } from '../src/system-metrics.mjs';

// The UI must never show an invented GPU/CPU number. Every reader is exercised
// on both the "data present" and the "data absent" path.

test('parseNvidiaSmi reads one GPU row and refuses garbage', () => {
  const one = parseNvidiaSmi('NVIDIA GeForce RTX 5070 Ti, 15705, 16303, 0, 22.06, 300.00, 42\n');
  assert.equal(one.length, 1);
  assert.deepEqual(one[0], {
    name: 'NVIDIA GeForce RTX 5070 Ti',
    memoryUsedMb: 15705,
    memoryTotalMb: 16303,
    utilization: 0,
    powerDrawW: 22.06,
    powerLimitW: 300,
    temperatureC: 42
  });
  // [N/A] is what nvidia-smi prints for unsupported fields; it must become null,
  // not NaN/0.
  const na = parseNvidiaSmi('RTX, 100, 200, [N/A], [N/A], [N/A], 50');
  assert.equal(na[0].utilization, null);
  assert.equal(na[0].powerDrawW, null);
  assert.equal(parseNvidiaSmi(''), null);
  assert.equal(parseNvidiaSmi('no, columns'), null);
});

test('cpuLoadFromSamples derives busy time from tick deltas', () => {
  // Same total, more idle → busier (75% used out of 100 ticks).
  assert.equal(cpuLoadFromSamples([{ idle: 100, total: 200 }], [{ idle: 125, total: 300 }]), 0.75);
  // All idle → 0, all busy → 1.
  assert.equal(cpuLoadFromSamples([{ idle: 0, total: 0 }], [{ idle: 100, total: 100 }]), 0);
  assert.equal(cpuLoadFromSamples([{ idle: 0, total: 0 }], [{ idle: 0, total: 100 }]), 1);
  // No previous sample (first poll), mismatched cores, or a frozen clock → null.
  assert.equal(cpuLoadFromSamples(null, [{ idle: 1, total: 2 }]), null);
  assert.equal(cpuLoadFromSamples([{ idle: 0, total: 0 }], [{ idle: 0, total: 0 }]), null);
  assert.equal(cpuLoadFromSamples([], []), null);
});

test('readRam reports used/total as bytes and a ratio', () => {
  const ram = readRam();
  assert.ok(ram.total > 0);
  assert.ok(ram.used >= 0 && ram.used <= ram.total);
  assert.ok(ram.ratio >= 0 && ram.ratio <= 1);
});

test('generationWindowMs spans the message, idle time included', () => {
  // First token at 10 000, message_end at 14 000: a 4 s window even though the
  // deltas inside it were 3 s apart — a local engine chunking slowly.
  assert.equal(generationWindowMs(10000, 14000), 4000);
  // No first delta (no stream at all), a zero/absent end, or a clock that went
  // backwards: no window, never a negative or invented one.
  assert.equal(generationWindowMs(0, 14000), 0);
  assert.equal(generationWindowMs(undefined, 14000), 0);
  assert.equal(generationWindowMs(10000, 0), 0);
  assert.equal(generationWindowMs(10000, 10000), 0);
  assert.equal(generationWindowMs(12000, 11000), 0);
});

test('computeTokensPerSecond guards against missing or nonsensical input', () => {
  assert.equal(computeTokensPerSecond(100, 2000), 50);
  assert.equal(computeTokensPerSecond(0, 1000), null);
  assert.equal(computeTokensPerSecond(100, 0), null);
  assert.equal(computeTokensPerSecond(undefined, 1000), null);
  assert.equal(computeTokensPerSecond(100, 'x'), null);
});

// The numbers a local model reports, checked against the engine's own log:
// Strata 2026-09-29 «prompt 82996 tokens = 82643 reused + 353 read in 1982 ms,
// 1336 generated in 39178 ms (34.1 tok/s)» must not come out as the 32 895 tok/s
// and the too-high TG that the previous arithmetic produced.
test('generationMetrics: a local engine without counters reports no PP', () => {
  const local = generationMetrics({
    usage: { input: 82996, cacheRead: 0, output: 1336 },
    promptMs: 2523,
    windowMs: 39178,
    engine: null,
    local: true
  });
  assert.equal(local.pp, null, 'a KV-cached local prompt has no measurable prefill rate');
  assert.equal(local.ppSource, null);
  assert.equal(local.ppApproximate, false);
  assert.equal(Math.round(local.tg), 34);
  assert.equal(local.tgSource, 'usage');
  // Prompt size stays visible even when the rate cannot be measured.
  assert.equal(local.inputTokens, 82996);
  assert.equal(local.outputTokens, 1336);
  assert.equal(local.ms, 39178);

  // With the engine's own counters (llama.cpp /metrics) those win.
  const withEngine = generationMetrics({
    usage: { input: 82996, output: 1336 },
    promptMs: 2523,
    windowMs: 39178,
    engine: { pp: 178.1, tg: 34.1, source: 'metrics' },
    local: true
  });
  assert.equal(withEngine.pp, 178.1);
  assert.equal(withEngine.tg, 34.1);
  assert.equal(withEngine.source, 'metrics');
});

test('generationMetrics: a remote provider gets an approximate prefill rate', () => {
  const remote = generationMetrics({
    usage: { input: 1000, cacheRead: 16000, output: 100 },
    promptMs: 2000,
    windowMs: 4000,
    engine: null,
    local: false
  });
  // 1000 prompt tokens, not 17 000: cache hits cost no prefill work.
  assert.equal(remote.pp, 500);
  assert.equal(remote.ppApproximate, true);
  assert.equal(remote.ppSource, 'ttft-estimate');
  assert.equal(remote.tg, 25);
  assert.equal(remote.inputTokens, 17000);
  assert.equal(remote.source, 'mixed');
});

test('generationMetrics returns nothing when there is nothing to report', () => {
  assert.equal(generationMetrics({ usage: {}, promptMs: 0, windowMs: 0, local: false }), null);
  assert.equal(generationMetrics({}), null);
  assert.equal(generationMetrics(), null);
  // No window (Pi streamed no delta): no TG, but a remote PP can still stand.
  const noWindow = generationMetrics({ usage: { input: 900, output: 0 }, promptMs: 1000, windowMs: 0, local: false });
  assert.equal(noWindow.tg, null);
  assert.equal(noWindow.pp, 900);
});

test('accumulateSessionSpeeds: max and average cover the turns that had a number', () => {
  const first = accumulateSessionSpeeds(null, { pp: 100, tg: 40 });
  assert.deepEqual(first, { turns: 1, ppMax: 100, ppAvg: 100, ppTurns: 1, tgAvg: 40, tgTurns: 1 });
  // A cache hit: Strata publishes no PP for it, so the session PP stays untouched
  // while the turn and its TG are counted.
  const second = accumulateSessionSpeeds(first, { pp: null, tg: 20 });
  assert.equal(second.turns, 2);
  assert.equal(second.ppTurns, 1);
  assert.equal(second.ppAvg, 100);
  assert.equal(second.tgAvg, 30);
  // A faster turn lifts the maximum but not the average by itself.
  const third = accumulateSessionSpeeds(second, { pp: 400, tg: 60 });
  assert.equal(third.ppMax, 400);
  assert.equal(third.ppAvg, 250);
  assert.equal(third.tgAvg, 40);
  assert.equal(third.turns, 3);
});

test('accumulateSessionSpeeds: garbage and zeros never become a measurement', () => {
  const zero = accumulateSessionSpeeds(null, { pp: 0, tg: 0 });
  assert.deepEqual(zero, { turns: 1, ppMax: null, ppAvg: null, ppTurns: 0, tgAvg: null, tgTurns: 0 });
  const nan = accumulateSessionSpeeds(null, { pp: 'fast', tg: Number.NaN });
  assert.equal(nan.ppMax, null);
  assert.equal(nan.tgAvg, null);
  // State that came back from disk with junk in it is repaired, not trusted.
  const repaired = accumulateSessionSpeeds({ turns: 'x', ppMax: 'no', ppAvg: -5, tgAvg: 10 }, { pp: 8, tg: 2 });
  assert.equal(repaired.turns, 1);
  assert.equal(repaired.ppTurns, 1);
  assert.equal(repaired.ppAvg, 8);
  assert.equal(repaired.ppMax, 8);
  assert.equal(repaired.tgTurns, 1);
  assert.equal(repaired.tgAvg, 2);
});
