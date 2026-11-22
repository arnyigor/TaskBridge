#!/usr/bin/env node
// Reliability Gate entrypoint. Deliberately does NOT pass --test-force-exit:
// on Windows that flag can trip a libuv assertion while the gate's own HTTP
// fixtures are closing (0xC0000409), making a real pass look like a crash.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.error('reliability gate: Windows is required (exact-PID fault injection)');
  process.exit(2);
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const child = spawn(process.execPath, ['--test', 'tests/reliability-gate.test.mjs'], {
  cwd: root,
  env: { ...process.env, RELIABILITY_GATE: '1' },
  stdio: 'inherit',
});
child.on('error', error => {
  console.error(`reliability gate could not start: ${error.message}`);
  process.exitCode = 2;
});
child.on('close', code => {
  console.log(`reliability gate: exit ${code ?? 1}; evidence in .local/reliability-gate/latest.json`);
  process.exitCode = code ?? 1;
});
