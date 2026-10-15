import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';

// Фаза 4: аномалии связи и доставки сервера должны быть видны в панели, а не
// только в копируемом бандле диагностики. Проверяем настоящую функцию рендера.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');

function extractFunction(source, name) {
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `в app.js нет функции ${name}`);
  let parens = 0;
  let index = source.indexOf('(', start);
  for (; index < source.length; index++) {
    if (source[index] === '(') parens++;
    else if (source[index] === ')') { parens--; if (parens === 0) break; }
  }
  let depth = 0;
  for (index = source.indexOf('{', index); index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}') { depth--; if (depth === 0) return source.slice(start, index + 1); }
  }
  throw new Error(`не найдена закрывающая скобка для ${name}`);
}

function panel() {
  const { document } = parseHTML('<!doctype html><html><body><div id="serverHealth"></div></body></html>');
  const $ = id => document.getElementById(id);
  const helpers = new Function('document', '$', [
    extractFunction(appSource, 'renderServerHealth'),
    'return { renderServerHealth };',
  ].join('\n'))(document, $);
  return { $, ...helpers };
}

test('a clean server shows no alarm line at all', () => {
  const p = panel();
  p.renderServerHealth({ server: { uptimeSec: 10, sseClients: 0, droppedStreams: 0, degradedEpisodes: 0, degradedClients: [] } });
  assert.equal(p.$('serverHealth').textContent, '', 'без аномалий строка пустая, а не «всё хорошо»');
});

test('degraded clients, dropped streams and a slow ack are visible', () => {
  const p = panel();
  p.renderServerHealth({
    server: {
      droppedStreams: 2,
      degradedEpisodes: 5,
      degradedClients: [
        { state: 'degraded', reason: 'stream closed' },
        { state: 'reconnecting', reason: 'stream closed' },
      ],
    },
    delivery: { observations: { ack_latency_ms: { p95: 9000 } } },
  });
  const text = p.$('serverHealth').textContent;
  assert.match(text, /связь теряют 2 клиент/);
  assert.match(text, /stream closed/);
  assert.match(text, /обрывов потока: 2/);
  assert.match(text, /эпизодов без связи: 5/);
  assert.match(text, /p95 подтверждения Pi: 9000 мс/);
});

test('a normal ack latency is not reported as an anomaly', () => {
  const p = panel();
  p.renderServerHealth({ server: { droppedStreams: 0, degradedEpisodes: 0, degradedClients: [] }, delivery: { observations: { ack_latency_ms: { p95: 120 } } } });
  assert.equal(p.$('serverHealth').textContent, '', 'обычная задержка — не повод показывать предупреждение');
});

test('metrics that did not arrive leave the line empty instead of inventing health', () => {
  const p = panel();
  p.renderServerHealth(null);
  assert.equal(p.$('serverHealth').textContent, '');
});
