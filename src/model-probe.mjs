// Короткая проверка модели по кнопке (пункт §3.3 плана, запрос оператора 2026-10-14).
//
// Зачем: `ModelLatency` копит TTFT настоящих ходов, поэтому «сколько ждёт эта модель»
// известно только ПОСЛЕ реального сообщения. Оператор узнавал о мёртвом провайдере,
// потеряв ход. Здесь два уровня проверки, и токены тратит только второй:
//
//   1) `availability` — бесплатный round-trip к `GET {baseUrl}/models`: отвечает ли
//      сервер вообще и за сколько миллисекунд. Ни одного токена.
//   2) `latency` — по явному нажатию: один запрос со `stream: true` и `max_tokens: 1`,
//      замер до первого дельта-чанка (это и есть TTFT), соединение сразу обрывается.
//      В ответе честно указано, что потрачено (`tokensUsed`, `mode: 'ttft'`).
//
// Результат проверки НЕ подмешивается в `ModelLatency`: проба на «ping» — не ответ
// модели на рабочий промпт, и смешивать их значило бы врать в статистике ходов.

export const PROBE_DEFAULTS = Object.freeze({
  timeoutMs: 10_000,
  // Кулдаун на модель: кнопку жмут повторно, когда «долго» — но бить по провайдеру
  // частыми запросами нельзя, а проба с токенами ещё и стоит денег.
  cooldownMs: 5_000,
});

/** {baseUrl}/chat/completions — рядом с `/models`, который уже используется синком. */
export function chatCompletionsUrl(baseUrl) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
}

/** `{provider}/{id}` — тот же ключ, что у каталога и у статистики задержек. */
export function probeKey(provider, id) {
  return `${provider || ''}/${id || ''}`;
}

/**
 * Контракт проверки соединения с провайдером (TB-PROV-01B).
 *
 * Отдельно от баланса и от проверки модели: `GET /models` говорит только о том,
 * что сервер вообще отвечает. HTTP 200 от `/models` не значит, что конкретная
 * модель умеет генерировать — для этого есть проба задержки.
 */
export const PROVIDER_CHECK_STATUSES = Object.freeze([
  'AVAILABLE', 'UNAUTHORIZED', 'RATE_LIMITED', 'TIMEOUT', 'UNREACHABLE', 'UNSUPPORTED', 'UNKNOWN',
]);

/**
 * Результат пробы → один из статусов контракта. Чистая функция: тест проверяет
 * правила, а не сеть.
 *
 * `UNSUPPORTED` — не «сломано», а «этот провайдер так проверить нельзя»: нет
 * адреса в каталоге, нет `/models` (404/405) или модель не описана у провайдера.
 */
export function providerCheckStatus({ ok = false, httpStatus = null, code = null } = {}) {
  if (ok) return 'AVAILABLE';
  if (httpStatus === 401 || httpStatus === 403) return 'UNAUTHORIZED';
  if (httpStatus === 429) return 'RATE_LIMITED';
  if (httpStatus === 404 || httpStatus === 405) return 'UNSUPPORTED';
  if (code === 'AUTH' || code === 'NO_KEY') return 'UNAUTHORIZED';
  if (code === 'TIMEOUT') return 'TIMEOUT';
  if (code === 'UNREACHABLE') return 'UNREACHABLE';
  if (code === 'NO_ENDPOINT' || code === 'MODEL_UNKNOWN' || code === 'REDIRECT') return 'UNSUPPORTED';
  // 5xx, COOLDOWN и всё незнакомое: честно «неизвестно», а не выдуманный вердикт.
  return 'UNKNOWN';
}

/**
 * Доступность провайдера: `GET /models` без токенов.
 * Возвращает время ответа и число моделей — этого достаточно, чтобы отличить
 * «провайдер жив, но модель недоступна» от «провайдер не отвечает».
 */
export async function probeAvailability({ baseUrl, apiKey = null, fetchImpl = globalThis.fetch, timeoutMs = PROBE_DEFAULTS.timeoutMs, modelsUrl }) {
  const url = modelsUrl || `${String(baseUrl || '').replace(/\/+$/, '')}/models`;
  const started = Date.now();
  try {
    const response = await fetchImpl(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
      // Redirect не выполняем: адрес узла пришёл из конфигурации сервера, но 302 на
      // внутренний адрес превратил бы проверку в SSRF-запрос от имени сервера
      // (пункт 2.2 плана). Честный отказ лучше тихого перехода.
      redirect: 'manual',
    });
    const ms = Date.now() - started;
    if (response.status >= 300 && response.status < 400) {
      return { mode: 'availability', ok: false, ms, httpStatus: response.status, code: 'REDIRECT', message: 'Провайдер перенаправляет запрос; переход по redirect не выполняется.' };
    }
    if (!response.ok) {
      return { mode: 'availability', ok: false, ms, httpStatus: response.status, code: response.status === 401 ? 'AUTH' : 'HTTP_ERROR' };
    }
    const payload = await response.json().catch(() => null);
    const models = Array.isArray(payload?.data) ? payload.data.length : Array.isArray(payload?.models) ? payload.models.length : null;
    return { mode: 'availability', ok: true, ms, httpStatus: response.status, models, tokensUsed: 0 };
  } catch (error) {
    return {
      mode: 'availability',
      ok: false,
      ms: Date.now() - started,
      code: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE',
      message: String(error?.message || error),
      tokensUsed: 0,
    };
  }
}

/**
 * Задержка модели: один короткий запрос со стримом, замер до первого дельта-чанка.
 *
 * `max_tokens: 1` и немедленный обрыв после первого чанка — минимальная возможная
 * цена. Если провайдер не умеет стрим (или ответил ошибкой), возвращается отказ, а не
 * подмена числа: «не смогли измерить» — это честный результат проверки.
 */
export async function probeLatency({
  baseUrl, id, apiKey = null, fetchImpl = globalThis.fetch,
  timeoutMs = PROBE_DEFAULTS.timeoutMs, maxTokens = 1, prompt = 'ping',
}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let abortedByUs = false;
  try {
    const response = await fetchImpl(chatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: id,
        max_tokens: maxTokens,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const ms = Date.now() - started;
      if (response.status === 404) return { mode: 'latency', ok: false, ms, httpStatus: 404, code: 'MODEL_NOT_FOUND' };
      return { mode: 'latency', ok: false, ms, httpStatus: response.status, code: response.status === 401 ? 'AUTH' : response.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR' };
    }
    // TTFT считается до первого СОДЕРЖАТЕЛЬНОГО delta, а не до TCP-чанка:
    // комментарий SSE, role-only delta и кусок JSON ещё не означают, что модель
    // начала отвечать. Ошибка в потоке также должна победить ложный «успех».
    const first = await firstModelSignal(response, {
      startedAt: started,
      onFirst: () => {
        abortedByUs = true;
        controller.abort();
      },
    });
    if (first === null) {
      return { mode: 'latency', ok: false, ms: Date.now() - started, code: 'NO_STREAM' };
    }
    if (first.error) {
      return { mode: 'latency', ok: false, ms: first.ms, code: 'PROVIDER_ERROR', message: first.error, httpStatus: response.status };
    }
    return { mode: 'latency', ok: true, ms: first.ms, tokensUsed: maxTokens, httpStatus: response.status };
  } catch (error) {
    const ms = Date.now() - started;
    // Abort после первого чанка — штатный путь: это мы оборвали.
    if (abortedByUs) return { mode: 'latency', ok: true, ms, tokensUsed: maxTokens };
    return {
      mode: 'latency',
      ok: false,
      ms,
      code: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE',
      message: String(error?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** One complete SSE event or raw JSON: error, meaningful model output, or noise. */
function providerSignal(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const data = value.split(/\r?\n/u)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .join('\n') || value;
  if (!data || data === '[DONE]' || data.startsWith(':')) return null;
  let parsed;
  try { parsed = JSON.parse(data); } catch { return null; }
  if (parsed?.error) {
    const error = parsed.error;
    return { error: typeof error === 'string' ? error : String(error.message || error.type || JSON.stringify(error)).slice(0, 300) };
  }
  const choices = Array.isArray(parsed?.choices) ? parsed.choices : [];
  const meaningful = choices.some(choice => {
    const delta = choice?.delta || {};
    const values = [delta.content, delta.reasoning_content, delta.reasoning, choice?.text];
    return values.some(item => Array.isArray(item)
      ? item.some(part => String(part?.text || part || '').length > 0)
      : typeof item === 'string' && item.length > 0);
  });
  return meaningful ? { token: true } : null;
}

/**
 * Waits for the first complete model signal. Chunks may split JSON arbitrarily;
 * role-only deltas and SSE comments are ignored. The caller's AbortController
 * enforces the deadline and is cancelled only after token/error is complete.
 */
async function firstModelSignal(response, { startedAt, onFirst }) {
  if (!response.body) {
    const text = await response.text().catch(() => '');
    const signal = providerSignal(text);
    if (!signal) return null;
    onFirst?.();
    return { ms: Date.now() - startedAt, ...signal };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value?.length) buffer += decoder.decode(value, { stream: !done });
      for (;;) {
        const boundary = buffer.search(/\r?\n\r?\n/u);
        if (boundary < 0) break;
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/u)?.[0] || '\n\n';
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + separator.length);
        const signal = providerSignal(event);
        if (signal) {
          onFirst?.();
          return { ms: Date.now() - startedAt, ...signal };
        }
      }
      if (done) {
        const signal = providerSignal(buffer);
        if (!signal) return null;
        onFirst?.();
        return { ms: Date.now() - startedAt, ...signal };
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* поток уже закрыт */ }
  }
}

/** Ошибка, пришедшая ВНУТРИ полного SSE-события или JSON. */
export function streamError(text) {
  return providerSignal(text)?.error || null;
}

/**
 * Кулдаун проб: одна модель — не чаще, чем раз в [cooldownMs]. Живёт в памяти
 * процесса: после перезапуска сервера кулдаун не нужен, оператор ждёт осознанно.
 */
export class ProbeCooldown {
  #last = new Map();

  constructor({ cooldownMs = PROBE_DEFAULTS.cooldownMs, now = () => Date.now() } = {}) {
    this.cooldownMs = cooldownMs;
    this.now = now;
  }

  /** Сколько ещё ждать (мс). 0 — можно проверять. */
  remaining(key) {
    const last = this.#last.get(String(key));
    if (!last) return 0;
    const left = this.cooldownMs - (this.now() - last);
    return left > 0 ? left : 0;
  }

  mark(key) {
    this.#last.set(String(key), this.now());
  }

  reset() {
    this.#last.clear();
  }
}
