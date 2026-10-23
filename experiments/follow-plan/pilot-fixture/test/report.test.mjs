// Интеграционный тест отчёта: CLI читает настоящий CSV и печатает итоги.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

test('отчёт по CSV печатает итоги и пустые остатки', () => {
  const out = execFileSync(process.execPath, [path.join(root, 'src', 'cli.mjs'), path.join(root, 'batches', 'stock.csv')], { encoding: 'utf8' });
  assert.match(out, /A-100\s+120/);
  assert.match(out, /B-200\s+35/);
  assert.match(out, /пусто:\s*A-101/);
});
