import test from 'node:test';
import assert from 'node:assert/strict';
import { TEXT_TAIL, THINKING_TAIL, tailText, appendTail, stripMcpAdapterNoise } from '../src/text-tail.mjs';

test('the mcp-adapter noise line is cut from accumulated text', () => {
  const noise = 'C:\\Users\\ArnyPC\\.pi\\agent\\mcp.json: Ignored settings (details in /mcp-adapter): "adb-mcp": directTools.';
  assert.equal(stripMcpAdapterNoise(`${noise}\nНормальный ответ`), 'Нормальный ответ');
  assert.equal(stripMcpAdapterNoise('Нормальный ответ'), 'Нормальный ответ');
  assert.equal(stripMcpAdapterNoise(''), '');
  assert.equal(stripMcpAdapterNoise(undefined), '');
  // A standalone noise line is dropped whole.
  assert.equal(stripMcpAdapterNoise(`Ответ\n${noise}\nДальше`), 'Ответ\nДальше');
  // Documented trade-off: a delta boundary that merged answer text into the
  // noise line loses that shared line too.
  let text = '';
  text = appendTail(text, 'Ответ. ', 64 * 1024);
  text = stripMcpAdapterNoise(appendTail(text, `${noise}\n`, 64 * 1024));
  assert.equal(text, '');
});

test('short text is returned unchanged', () => {
  assert.equal(tailText('hello', 100), 'hello');
  assert.equal(tailText(undefined, 100), '');
  assert.equal(appendTail('a', 'b', 100), 'ab');
});

test('long text keeps only a bounded tail with a marker', () => {
  const long = 'x'.repeat(5000);
  const result = tailText(long, 1000);
  assert.ok(result.length <= 1000);
  assert.match(result, /символов опущены/);
  assert.ok(result.endsWith('x'.repeat(100)));
  assert.equal(result.slice(-100), long.slice(-100));
});

test('appendTail never exceeds the cap while appending deltas', () => {
  let text = '';
  for (let i = 0; i < 500; i++) text = appendTail(text, '0123456789', 256);
  assert.ok(text.length <= 256, `length ${text.length}`);
  assert.ok(text.endsWith('0123456789'));
});

test('default caps stay bounded', () => {
  assert.ok(TEXT_TAIL > THINKING_TAIL);
  assert.ok(THINKING_TAIL <= 64 * 1024);
});
