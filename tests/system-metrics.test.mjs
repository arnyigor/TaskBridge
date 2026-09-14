import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNvidiaSmi, cpuLoadFromSamples, readRam, computeTokensPerSecond, accumulateStreamMs } from '../src/system-metrics.mjs';

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

test('accumulateStreamMs counts generation gaps but not tool-execution pauses', () => {
  // No previous delta yet: nothing to add.
  assert.equal(accumulateStreamMs(0, 1000, 0), 0);
  // Two deltas 200 ms apart: generation time grows by 200 ms.
  assert.equal(accumulateStreamMs(1000, 1200, 0), 200);
  assert.equal(accumulateStreamMs(1000, 1200, 500), 700);
  // Exactly at the limit is still counted; beyond it is a pause (tool call).
  assert.equal(accumulateStreamMs(1000, 3000, 0), 2000);
  assert.equal(accumulateStreamMs(1000, 4000, 250), 250);
  // A clock that appears to go backwards adds nothing instead of going negative.
  assert.equal(accumulateStreamMs(2000, 1500, 300), 300);
});

test('computeTokensPerSecond guards against missing or nonsensical input', () => {
  assert.equal(computeTokensPerSecond(100, 2000), 50);
  assert.equal(computeTokensPerSecond(0, 1000), null);
  assert.equal(computeTokensPerSecond(100, 0), null);
  assert.equal(computeTokensPerSecond(undefined, 1000), null);
  assert.equal(computeTokensPerSecond(100, 'x'), null);
});
