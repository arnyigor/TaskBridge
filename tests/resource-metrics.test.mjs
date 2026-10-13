import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './server-fixture.mjs';
import { parseNvidiaSmiQueryGpu, systemRam } from '../src/process-info.mjs';

// PROC-01 (docs/TASKBRIDGE_RESOURCE_CLEANUP_PLAN.md): the resource snapshot must
// distinguish OS RAM from sums of process working sets, and an "N/A" from
// nvidia-smi must stay null — it never becomes "0 MB free".

test('parseNvidiaSmiQueryGpu parses values and keeps N/A as null', () => {
  const gpus = parseNvidiaSmiQueryGpu(
    'NVIDIA GeForce RTX 5070 Ti, 16311, 6204, 10107, 34\r\n' +
    'NVIDIA GeForce RTX 3090, 24576, [N/A], 24576, [N/A]\n',
  );
  assert.equal(gpus.length, 2);
  assert.equal(gpus[0].name, 'NVIDIA GeForce RTX 5070 Ti');
  assert.equal(gpus[0].vramTotalMb, 16311);
  assert.equal(gpus[0].vramUsedMb, 6204);
  assert.equal(gpus[0].vramFreeMb, 10107);
  assert.equal(gpus[0].utilizationPercent, 34);
  // The second card does not report some values: unknown, never zero.
  assert.equal(gpus[1].vramUsedMb, null);
  assert.equal(gpus[1].utilizationPercent, null);
  assert.equal(gpus[1].vramFreeMb, 24576);
});

test('parseNvidiaSmiQueryGpu returns [] for empty output', () => {
  assert.deepEqual(parseNvidiaSmiQueryGpu(''), []);
  assert.deepEqual(parseNvidiaSmiQueryGpu(null), []);
});

test('systemRam returns consistent OS numbers, not a process sum', () => {
  const ram = systemRam();
  assert.ok(ram.totalBytes > 0);
  assert.ok(ram.freeBytes > 0);
  assert.equal(ram.usedBytes, ram.totalBytes - ram.freeBytes);
  assert.equal(typeof ram.sampledAt, 'string');
});

test('GET /api/system/resources returns the aggregate snapshot', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());

  const { ram, gpu } = await fixture.api('/api/system/resources');
  assert.ok(ram.totalBytes > 0);
  assert.ok(ram.freeBytes > 0);
  assert.equal(ram.usedBytes, ram.totalBytes - ram.freeBytes);
  // gpu is null when nvidia-smi is unavailable; otherwise each field is a number or null.
  if (gpu !== null) {
    assert.ok(Array.isArray(gpu.gpus));
    for (const card of gpu.gpus) {
      assert.equal(typeof card.name, 'string');
      for (const key of ['vramTotalMb', 'vramUsedMb', 'vramFreeMb', 'utilizationPercent']) {
        assert.ok(card[key] === null || Number.isFinite(card[key]), `${key} must be a number or null`);
      }
    }
    assert.equal(typeof gpu.sampledAt, 'string');
  }
});
