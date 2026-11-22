import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// Exercise the production private method without starting a real agent/session.
const source = await fs.readFile(new URL('../src/task-manager.mjs', import.meta.url), 'utf8');
const method = source.match(/#piEnv\(launch = null\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(method, '#piEnv exists');
const piEnv = new Function(`return ({${method.replace('#piEnv', 'piEnv')}}).piEnv`)();
const envFor = env => piEnv.call({ config: { pi: { env } }, mcp: { launch: () => ({ env: {} }) } });

test('Pi Python UTF-8 default is inherited and an explicit configuration wins', () => {
  assert.equal(envFor({}).PYTHONUTF8, '1');
  assert.equal(envFor({ PYTHONUTF8: '0' }).PYTHONUTF8, '0');
  assert.equal(envFor({ PYTHONIOENCODING: 'cp1251' }).PYTHONIOENCODING, 'cp1251');
});

test('Windows Python child writes readable UTF-8 to stdout and stderr', { skip: process.platform !== 'win32' }, t => {
  const env = { ...process.env, ...envFor({}) };
  delete env.PYTHONIOENCODING;
  const result = spawnSync('python', ['-c', String.raw`import sys; print('installed.json \u043e\u0431\u043d\u043e\u0432\u043b\u0451\u043d'); print('Basalt: \u0442\u0435\u043a\u0443\u0449\u0430\u044f 0.5.0', file=sys.stderr); sys.exit(3)`], { env, timeout: 5000 });
  if (result.error?.code === 'ENOENT') return t.skip('Python is not installed');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 3);
  assert.equal(result.stdout.toString('utf8').trim(), 'installed.json обновлён');
  assert.equal(result.stderr.toString('utf8').trim(), 'Basalt: текущая 0.5.0');
});
