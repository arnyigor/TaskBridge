// Бандл диагностики доставки (шаг C-C плана улучшений): «Скопировать
// диагностику» собирает одним JSON то, что нужно для разбора «зависло/не
// отправляется» по чек-листу docs/message-delivery-analysis.md §5.
//
// Приватность: содержимое приватных prompt в бандл НЕ попадает — только
// метаданные (статусы, времена, длины). Тексты сообщений, промпт сессии,
// in-flight текст и тексты очереди вырезаются явно, см. #publicMeta.
// Точные тайминги RPC/ACK лежат на сервере в pi-events.jsonl
// (записи taskbridge_turn_timing) — бандл называет эти файлы.

export const DIAGNOSTICS_VERSION = 1;

// Поля задачи, которые не должны покидать машину оператора.
const PRIVATE_TASK_FIELDS = new Set([
  'prompt', 'assistantText', 'thinkingText', 'followup', 'followupInstructions',
  'errorStack', 'apiKeys', 'secrets',
  // Подтверждённые результаты инструментов — это содержимое файлов и вывод
  // команд (§7 плана 1.3). Бандл копируется в буфер и уходит человеку, поэтому
  // выжимки в него не попадают: диагностике нужно только «сколько и чего».
  'toolEvidence'
]);

function publicMeta(value) {
  if (Array.isArray(value)) return value.map(publicMeta);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_TASK_FIELDS.has(key)) { out[key] = '<removed>'; continue; }
    if (key === 'text') { out[key] = '<removed>'; continue; } // in-flight / очередь / pendingPrompts
    out[key] = publicMeta(item);
  }
  return out;
}

/**
 * Здоровье сервера для бандла: числа и причины, без идентификаторов клиентов.
 *
 * Отдельно от /api/metrics: в бандл попадает только то, что помогает диагнозу
 * («сколько обрывов», «кто именно» — лишнее), и ничего из содержимого сессий.
 */
export function publicServerHealth(metrics) {
  const server = metrics?.server;
  if (!server) return null;
  const number = value => (Number.isFinite(value) ? value : null);
  return {
    uptimeSec: number(server.uptimeSec),
    sseClients: number(server.sseClients),
    eventChainDepth: number(server.eventChainDepth),
    droppedStreams: number(server.droppedStreams),
    degradedEpisodes: number(server.degradedEpisodes),
    recoveredEpisodes: number(server.recoveredEpisodes),
    lastDegradedAt: server.lastDegradedAt ?? null,
    // Состояния без clientId: оператору важно «сколько и почему», а не кто.
    degraded: (Array.isArray(server.degradedClients) ? server.degradedClients : [])
      .map(entry => ({ state: entry?.state ?? null, since: entry?.since ?? null, reason: entry?.reason ?? null, attempt: number(entry?.attempt) })),
    ackLatencyP95Ms: number(metrics?.delivery?.observations?.['ack_latency_ms']?.p95),
    ssePublishLagP95Ms: number(metrics?.delivery?.observations?.['sse_publish_lag_ms']?.p95),
  };
}

function pickTask(task) {
  if (!task) return null;
  const meta = publicMeta(task);
  // Публичные поля задачи уже содержат tailed-тексты (assistantText и др.) —
  // они заменены на <removed>; в бандл берём только то, что нужно диагнозу.
  return {
    id: meta.id ?? null,
    title: meta.title ?? null,
    status: meta.status ?? null,
    // current may contain tool arguments (including private shell commands).
    current: task.current == null ? null : '<removed>',
    statusChangedAt: meta.statusChangedAt ?? null,
    queueReason: meta.queueReason ?? null,
    error: meta.error ?? null,
    errorCode: meta.errorCode ?? null,
    retryable: meta.retryable ?? null,
    retryAfterMs: meta.retryAfterMs ?? null,
    model: meta.model ? { provider: meta.model.provider ?? null, id: meta.model.id ?? null } : null,
    requestedModel: meta.requestedModel ? { provider: meta.requestedModel.provider ?? null, id: meta.requestedModel.id ?? null } : null,
    runtime: meta.runtime ?? null,
    compaction: meta.compaction ?? null,
    pendingPrompts: Array.isArray(task.pendingPrompts)
      ? task.pendingPrompts.map(p => ({ id: p?.id ?? null, mode: p?.mode ?? null }))
      : [],
    inFlightPrompt: task.inFlightPrompt ? { at: task.inFlightPrompt.at ?? null, initial: task.inFlightPrompt.initial === true } : null,
    providerWait: meta.providerWait ?? null,
    piPid: meta.piPid ?? null,
    piStartedAt: meta.piStartedAt ?? null,
    sessionAvailable: meta.sessionAvailable ?? null,
    createdAt: meta.createdAt ?? null,
    updatedAt: meta.updatedAt ?? null
  };
}

/**
 * Собирает бандл диагностики. Все входы — уже собранные клиентом данные,
 * никаких обращений к DOM/сети: чистая функция для тестов.
 *
 * @param {object} input
 * @param {number}   [input.now]              ms epoch момента сборки
 * @param {object}   [input.client]           { kind, transport, origin, online, build }
 * @param {object}   [input.task]             публичная задача (currentTask из app.js)
 * @param {object}   [input.chat]             { cursor } — последний применённый SSE seq
 * @param {object}   [input.model]            { busy, ready, engine } из /api/info
 * @param {number}   [input.queuedLocal]      сколько сообщений ждёт в локальной очереди UI
 * @param {boolean}  [input.lastPromptFailed] последняя отправка упала
 * @param {string[]} [input.sendErrors]       последние ошибки отправки (тексты showNotice)
 */
export function buildDiagnosticsBundle({
  now = Date.now(), client = {}, task = null, chat = null,
  model = {}, queuedLocal = 0, lastPromptFailed = false, sendErrors = [], server = null
} = {}) {
  return {
    diagnosticsVersion: DIAGNOSTICS_VERSION,
    generatedAt: new Date(now).toISOString(),
    client: {
      kind: client.kind ?? 'web',
      transport: client.transport ?? null,          // 'local' | 'cloud'
      origin: client.origin ?? null,
      online: client.online ?? null,
      build: client.build ?? null                   // версия/коммит сервера из /api/info
    },
    task: pickTask(task),
    // Фаза 4: здоровье сервера — то, что оператор иначе сообщает словами («часто
    // отваливается»). Только числа и причины, без идентификаторов клиентов и без
    // чего-либо из содержимого сессий: бандл уезжает в чат/по почте.
    server: publicServerHealth(server),
    delivery: {
      cursor: chat?.cursor ?? null,                 // последний применённый SSE seq клиента
      queuedLocal,
      lastPromptFailed,
      // §5 п.7: где на сервере лежит полная трасса хода.
      serverArtifacts: [
        'data/tasks/<taskId>/artifacts/pi-events.jsonl (raw-кадры Pi + taskbridge_turn_timing)',
        'data/tasks/<taskId>/artifacts/pi.stderr.log',
        'data/tasks/<taskId>/events (SQLite, /api/tasks/:id/events)'
      ]
    },
    model: {
      busy: model.busy ?? null,                     // true/false/null(unknown)
      ready: model.ready ?? null,
      engine: model.engine ?? null                  // configured/reachable/model/slots
    },
    sendErrors: sendErrors.slice(-5)
  };
}
