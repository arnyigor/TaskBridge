import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagnosticsBundle, DIAGNOSTICS_VERSION } from '../web/diagnostics.mjs';

// Бандл «Скопировать диагностику» (шаг C-C): один JSON по чек-листу
// docs/message-delivery-analysis.md §5 — без содержимого приватных промптов.

const SECRET = 'секретный-промпт-оператора';

const task = {
  id: 't-1',
  title: 'Правка очереди',
  prompt: SECRET,
  assistantText: `${SECRET} ответ`,
  thinkingText: SECRET,
  status: 'RUNNING',
  current: 'Pi starting',
  statusChangedAt: '2026-10-13T10:00:00.000Z',
  queueReason: null,
  error: null,
  errorCode: null,
  model: { provider: 'llamacpp', id: 'qwen' },
  requestedModel: { provider: 'llamacpp', id: 'qwen' },
  runtime: { state: 'live', activity: null, compacting: false, compactingSince: 0 },
  pendingPrompts: [{ id: 'p1', text: SECRET, mode: 'auto' }],
  inFlightPrompt: { text: SECRET, at: '2026-10-13T10:00:01.000Z', initial: false },
  piPid: 4242,
  piStartedAt: '2026-10-13T09:59:00.000Z',
  sessionAvailable: true,
  createdAt: '2026-10-13T09:58:00.000Z',
  updatedAt: '2026-10-13T10:00:02.000Z'
};

test('the bundle carries the §5 checklist fields', () => {
  const bundle = buildDiagnosticsBundle({
    now: Date.parse('2026-10-13T10:00:03.000Z'),
    client: { kind: 'web', transport: 'local', origin: 'http://192.168.1.5:8787', online: true, build: { version: '0.11.0' } },
    task,
    chat: { cursor: 42 },
    model: { busy: null, ready: true, engine: { configured: true, reachable: true } },
    queuedLocal: 1,
    lastPromptFailed: true,
    sendErrors: ['2026-10-13T10:00:02.000Z MODEL_BUSY: x']
  });

  assert.equal(bundle.diagnosticsVersion, DIAGNOSTICS_VERSION);
  assert.equal(bundle.client.transport, 'local');
  assert.equal(bundle.task.id, 't-1');
  assert.equal(bundle.task.status, 'RUNNING');
  assert.deepEqual(bundle.task.model, { provider: 'llamacpp', id: 'qwen' });
  assert.deepEqual(bundle.task.pendingPrompts, [{ id: 'p1', mode: 'auto' }]);
  assert.deepEqual(bundle.task.inFlightPrompt, { at: '2026-10-13T10:00:01.000Z', initial: false });
  assert.equal(bundle.task.piPid, 4242);
  assert.equal(bundle.delivery.cursor, 42, 'последний применённый SSE seq клиента');
  assert.equal(bundle.delivery.queuedLocal, 1);
  assert.equal(bundle.delivery.lastPromptFailed, true);
  assert.ok(Array.isArray(bundle.delivery.serverArtifacts) && bundle.delivery.serverArtifacts.length >= 3);
  assert.equal(bundle.model.busy, null);
  assert.equal(bundle.model.ready, true);
  assert.equal(bundle.sendErrors.length, 1);
});

test('the bundle never carries private prompt content', () => {
  const bundle = buildDiagnosticsBundle({ now: Date.now(), task, chat: { cursor: 1 } });
  const text = JSON.stringify(bundle);
  assert.ok(!text.includes(SECRET), 'prompt/assistant/thinking/queued/in-flight texts must be stripped');
  assert.ok(!('prompt' in bundle.task), 'prompt field is absent from the bundle');
  assert.ok(!('assistantText' in bundle.task), 'assistantText field is absent from the bundle');
});

test('tool arguments in current never reach the copied diagnostics', () => {
  const bundle = buildDiagnosticsBundle({ task: { ...task, current: `bash: echo ${SECRET}` } });
  assert.equal(bundle.task.current, '<removed>');
  assert.ok(!JSON.stringify(bundle).includes(SECRET));
});

test('the bundle tolerates absent state (fresh page, no session)', () => {
  const bundle = buildDiagnosticsBundle({ now: 0 });
  assert.equal(bundle.task, null);
  assert.equal(bundle.delivery.cursor, null);
  assert.equal(bundle.model.busy, null);
  assert.equal(bundle.client.kind, 'web');
});

// Фаза 4: в бандл попадает здоровье сервера — числа и причины, без clientId и
// без чего-либо из содержимого сессий (бандл уезжает в чат или по почте).
test('diagnostics carry server health without client ids or prompt content', () => {
  const metrics = {
    server: {
      uptimeSec: 3600,
      sseClients: 2,
      eventChainDepth: 0,
      droppedStreams: 3,
      degradedEpisodes: 4,
      recoveredEpisodes: 3,
      lastDegradedAt: '2026-10-14T10:55:17.698Z',
      degradedClients: [{ clientId: 'android-42', state: 'degraded', since: '2026-10-14T10:50:00.000Z', reason: 'stream closed', attempt: 2 }],
    },
    delivery: { observations: { ack_latency_ms: { p95: 120 }, sse_publish_lag_ms: { p95: 40 } } },
  };
  const bundle = buildDiagnosticsBundle({ now: 0, server: metrics });
  assert.equal(bundle.server.droppedStreams, 3);
  assert.equal(bundle.server.degradedEpisodes, 4);
  assert.equal(bundle.server.ackLatencyP95Ms, 120);
  assert.equal(bundle.server.ssePublishLagP95Ms, 40);
  assert.equal(bundle.server.degraded[0].reason, 'stream closed');
  assert.equal(bundle.server.degraded[0].attempt, 2);
  assert.ok(!('clientId' in bundle.server.degraded[0]), 'идентификатор клиента в бандл не уходит');
  assert.ok(!JSON.stringify(bundle.server).includes('android-42'));
});

test('without metrics the server section is null rather than a lie', () => {
  assert.equal(buildDiagnosticsBundle({ now: 0 }).server, null);
  assert.equal(buildDiagnosticsBundle({ now: 0, server: {} }).server, null);
});

test('выжимки выводов инструментов не попадают в бандл диагностики', () => {
  // Результаты инструментов — это содержимое файлов (§7 плана 1.3). Бандл
  // копируется в буфер и уходит человеку, поэтому в него идёт только форма:
  // сколько записей и по каким инструментам, без текста.
  const proofText = 'DEEPSEEK_API_KEY=sk-live-0123456789abcdef';
  const bundle = buildDiagnosticsBundle({
    now: Date.now(),
    task: { ...task, status: 'FAILED', errorCode: 'MODEL_ERROR', error: 'Fixture model error',
      toolEvidence: [{ toolName: 'bash', target: 'env', excerpt: proofText }] },
    chat: { cursor: 7 },
  });
  const text = JSON.stringify(bundle);
  assert.doesNotMatch(text, /sk-live-0123456789abcdef/, 'выжимка не уходит в буфер');
  assert.doesNotMatch(text, /toolEvidence/, 'даже имени поля в бандле нет');
});
