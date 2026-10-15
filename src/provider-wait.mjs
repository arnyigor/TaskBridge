// Состояние «ждём провайдера»: разбор объявлений Pi и pi-limits-wait, дедупликация
// тиков одного эпизода и публикация PROVIDER_WAIT/PROVIDER_WAIT_END.
// Выделено из task-manager.mjs 2026-10-15; поведение не менялось, только перенос.

function now() { return new Date().toISOString(); }

// A retry the agent announces while it is still alive is PROGRESS, not a result:
// «… retrying after error in 0m 05s. Error: Connection error.», «⏳ pi-limits-wait:
// … still alive, waiting 0m 05s before the next retry», «… error for 0m 30s;
// waiting, then retrying». Shown verbatim in the chat they read as a failure the
// agent does not have — the operator sees «Агент работает» and a wall of “Error:”
// at the same time (observed 2026-09-29 with a restarting local model). The chat
// note is dropped; the raw frame stays in pi-events.jsonl, and a real failure
// still arrives as the message's own error / TASK_FAILED.
export const RETRY_IN_PROGRESS_NOTICE = /retrying after error|before the next retry|then retrying/iu;
// «… failed and pi-limits-wait is not retrying: Connection error.» — противоположный
// случай: повтора НЕ будет (2026-10-12, расширение 0.6.4). Такое объявление — отказ, а не
// ожидание, и в чат оно уходит нашими словами, как и само ожидание: сырая английская
// строка в ленте читается как чужая ошибка без модели и причины.
export const GIVE_UP_NOTICE = /failed and pi-limits-wait is not retrying/iu;
// «Ждём провайдера» — не ошибка и не событие чата, а состояние сессии: столько
// тишины оператор иначе не отличит от сломанного моста. Обещанный повтор бывает
// долгим (2026-10-09: HTTP 429 «user reached the limit», `retry-after-ms 5452000`),
// а объявление приходит каждые 15 с — поэтому разбираем его в `task.providerWait`
// и публикуем один раз на раунд ожидания (PROVIDER_WAIT), тики только уточняют
// остаток. Момент повтора держим абсолютным (`retryAt`), чтобы клиент считал
// обратный отсчёт сам, а не перерисовывал чужие секунды.
export const PROVIDER_WAIT_CURRENT = 'Ждём провайдера:';
// Одну и ту же модель Pi называет двумя оборотами: сам — «<модель> retrying after
// error in 0m 05s», расширение pi-limits-wait — «retrying after error on <модель>»
// и «network/timeout error on <модель>». Оборот «in …» совпадал с прежним
// шаблоном с необязательным «on», и моделью становилось слово «in»: 2026-10-12 в
// чат уходило «Провайдер in не принял запрос: HTTP 507 «HTTP 507»».
const WAIT_NOTICE_MODEL = {
  leading: /^\s*([\w.@/:-]+)\s+(?:rate limited|retrying after error|network\/timeout error)\b/iu,
  rateLimitedOn: /rate limited on\s+([\w.@/:-]+)/iu,
  networkErrorOn: /network\/timeout error on\s+([\w.@/:-]+)/iu,
  afterErrorOn: /retrying after error on\s+([\w.@/:-]+)/iu,
};
const WAIT_NOTICE_DURATION = [
  // «… network/timeout error for 0m 15s; waiting, then retrying» — срок называет
  // сам Pi; расширение говорит «waiting … before the next retry».
  /(?:error|limited) for\s+(.+?)[;.]/iu,
  /waiting\s+(.+?)\s+before the next retry/iu,
  /retrying after error in\s+(.+?)[.;]/iu,
];
const WAIT_NOTICE_CLOCK = /(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(\d+)\s*s\b/u;

/** Причина одной строкой: без HTTP-обвязки и без точки на конце. */
function trimCause(text) {
  return String(text || '')
    .replace(/^HTTP\s+\d{3}[^;]*;\s*(?:Error:\s*)?/iu, '')
    .trim().replace(/\.+$/, '').slice(0, 200) || null;
}

/** Своими словами провайдера: JSON, который он прислал, иначе названная причина. */
function providerWaitReason(text) {
  const quoted = /"message"\s*:\s*"([^"]{1,200})"/u.exec(text)?.[1]?.trim();
  if (quoted) return quoted;
  // Причину называют двумя оборотами: Pi — «… Error: fetch failed», расширение —
  // «… before the next retry. Why: fetch failed». Без хвоста причины нет:
  // повторять целую строку уведомления оператору было бы шумом, а не причиной.
  const cause = /Why:\s*(.+)$/isu.exec(text)?.[1] || /Error:\s*(.+)$/isu.exec(text)?.[1] || '';
  return trimCause(cause);
}

/** Момент времени из поля кадра: число — уже эпоха, строка — ISO. */
function waitInstant(value) {
  const millis = typeof value === 'number' ? value : Date.parse(String(value || ''));
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

/**
 * Разбирает уведомление Pi о повторе: какой провайдер, сколько ждать и почему.
 * null — уведомление не про ожидание (тогда показывать нечего).
 */
export function parseProviderWait(message) {
  const text = String(message || '');
  const model = WAIT_NOTICE_MODEL.rateLimitedOn.exec(text)?.[1]
    || WAIT_NOTICE_MODEL.networkErrorOn.exec(text)?.[1]
    || WAIT_NOTICE_MODEL.afterErrorOn.exec(text)?.[1]
    || WAIT_NOTICE_MODEL.leading.exec(text)?.[1]
    || null;
  const clock = WAIT_NOTICE_DURATION.map(re => re.exec(text)).find(Boolean)?.[1];
  const parts = clock ? WAIT_NOTICE_CLOCK.exec(clock) : null;
  const clockMs = parts
    ? ((Number(parts[1]) || 0) * 3600 + (Number(parts[2]) || 0) * 60 + (Number(parts[3]) || 0)) * 1000
    : null;
  const http = /HTTP\s+(\d{3})/iu.exec(text)?.[1];
  const retryAfter = /retry-after-ms\s+(\d+)/iu.exec(text)?.[1];
  const httpStatus = http ? Number(http) : null;
  // Ждать можно и без числа (тогда `retry-after-ms` — единственная оценка).
  const waitMs = clockMs ?? (retryAfter ? Number(retryAfter) : null);
  return {
    kind: httpStatus === 429 || /rate limited/iu.test(text) ? 'rate-limit' : 'retry',
    model,
    provider: model ? model.split('/')[0] : null,
    httpStatus,
    reason: providerWaitReason(text),
    waitMs: Number.isFinite(waitMs) && waitMs > 0 ? waitMs : null,
  };
}

/**
 * То же самое, но из машинного кадра `setStatus` с ключом `…pi-limits-wait.json`:
 * `pi-limits-wait` отдаёт `reason`, модель и абсолютный `plannedDeadline` полями,
 * без разбора прозы. Это и предпочтительный источник — текст уведомления меняется
 * от версии к версии, а поля — нет.
 *
 * null — кадр не про ожидание или не разобрался (тогда остаётся текстовая ветка,
 * а не молчание).
 */
export function parseProviderWaitStatus(statusText) {
  let data;
  try { data = JSON.parse(String(statusText || '')); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  // `give_up` — конец ожидания без повтора: расширение сказало, что повторять не будет.
  // Полей `model`/`periodId` в этом кадре нет — модель и причину оно называет текстом.
  if (data.event === 'give_up') {
    const parsed = parseProviderGiveUp(String(data.message || ''));
    return { ...parsed, giveUp: true, kind: 'retry', httpStatus: null, periodId: null, waitMs: null, retryAt: null };
  }
  if (data.event !== 'wait') return null;
  const error = String(data.error || '');
  const notice = String(data.message || '');
  const http = /HTTP\s+(\d{3})/iu.exec(error)?.[1] || /HTTP\s+(\d{3})/iu.exec(notice)?.[1];
  const provider = data.model?.provider ? String(data.model.provider) : null;
  const id = data.model?.id ? String(data.model.id) : null;
  const model = provider && id ? `${provider}/${id}` : (id || provider);
  const remaining = Number(data.remainingMs);
  const deadline = waitInstant(data.plannedDeadline);
  return {
    kind: String(data.reason || '').includes('rate-limit') || http === '429' ? 'rate-limit' : 'retry',
    model,
    provider,
    httpStatus: http ? Number(http) : null,
    // `periodId` — эпизод ожидания: внутри него расширение успевает сменить и
    // `waitId`, и причину (retry ↔ network), и объявленный срок (5 с → 15 с).
    periodId: data.periodId ? String(data.periodId) : null,
    // Здесь причина — само поле `error` («fetch failed», «Connection error.»):
    // прозы с «Error:»/«Why:» в машинном кадре нет.
    reason: providerWaitReason(error || notice) || trimCause(error) || trimCause(notice),
    // Остаток берём готовым, а не из часов: сервер и клиент расходятся на секунды,
    // а мс до дедлайна — одно и то же число.
    waitMs: remaining > 0 ? remaining : null,
    retryAt: deadline,
    since: waitInstant(data.startedAt),
  };
}

/** «1 ч 31 мин», «30 с» — теми же единицами, что в объявлении Pi. */
function humanWait(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours} ч ${minutes} мин`;
  if (minutes) return `${minutes} мин ${seconds} с`;
  return `${seconds} с`;
}

/** Строка ожидания для «Активность» в диагностике: причина и остаток. */
function providerWaitCurrent(wait) {
  const cause = wait.httpStatus ? `HTTP ${wait.httpStatus}` : (wait.reason || 'нет ответа').slice(0, 120);
  // Остаток — от момента повтора, а не от объявления: одна и та же строка
  // живёт весь раунд, а секунды идут.
  const left = humanWait(wait.retryAt ? Date.parse(wait.retryAt) - Date.now() : wait.waitMs);
  return `${PROVIDER_WAIT_CURRENT} ${cause}${left ? ` — повтор через ${left}` : ''}`.slice(0, 300);
}

/** Строка для чата: что именно отказал провайдер и когда Pi повторит. */
function providerWaitMessage(wait) {
  const who = wait.model ? ` ${wait.model}` : '';
  // Причина, повторяющая код («HTTP 507 «HTTP 507»»), — шум: код уже назван.
  const repeated = Boolean(wait.reason) && Number.isFinite(wait.httpStatus)
    && new RegExp(`^HTTP\\s+${wait.httpStatus}$`, 'iu').test(String(wait.reason).trim());
  const cause = wait.httpStatus
    ? `HTTP ${wait.httpStatus}${wait.reason && !repeated ? ` «${wait.reason}»` : ''}`
    : (wait.reason || 'провайдер не отвечает');
  const left = humanWait(wait.waitMs);
  return `Провайдер${who} не принял запрос: ${cause}. Pi жив и повторит${left ? ` через ${left}` : ' позже'} — сессия не зависла.`;
}

/** Модель и причина из «<модель> failed and pi-limits-wait is not retrying: <причина>». */
export function parseProviderGiveUp(text) {
  const raw = String(text || '');
  const model = /^\s*([\w.@/:-]+)\s+failed and pi-limits-wait is not retrying/iu.exec(raw)?.[1] || null;
  const cause = /is not retrying:\s*(.+)$/isu.exec(raw)?.[1] || '';
  return { model, provider: model ? model.split('/')[0] : null, reason: trimCause(cause) };
}

/** Строка для чата: повтор не состоится — это уже не «ждём провайдера». */
export function providerGiveUpMessage(giveUp) {
  const who = giveUp.model ? ` ${giveUp.model}` : '';
  const why = giveUp.reason ? `: ${giveUp.reason}` : '';
  return `Провайдер${who} не принял запрос и повторять не будет${why}.`;
}

/**
 * То же самое ожидание, а не новый отказ?
 *
 * Машинный кадр называет эпизод сам (`periodId`); проза его не несёт, и её
 * привязывают по виду отказа и модели. Разные эпизоды при этом не сливаются:
 * как только эпизод сменился, новый `periodId` перестаёт совпадать.
 */
export function sameProviderWait(current, wait) {
  if (!current) return false;
  if (wait.periodId && current.periodId) return wait.periodId === current.periodId;
  return current.kind === wait.kind && current.model === wait.model;
}

/**
 * Запоминает, что Pi сказал о запланированном повторе, и сообщает об этом один
 * раз на раунд ожидания. Публикация — через `emit(type, message, data)`, который
 * подставляет владелец задачи (TaskManager).
 *
 * Тишина провайдера выглядит точно так же, как сломанный мост: события идут с
 * последнего ответа модели, статус RUNNING, активность streaming. Единственный
 * признак жизни — это самое объявление, и оно меняется каждые 15 с только числом
 * оставшихся секунд. Поэтому событие публикуется на смену раунда (другой вид
 * отказа, модель или дедлайн), а тики внутри раунда только уточняют остаток.
 */
export async function noteProviderWait(task, wait, emit, at = now()) {
  if (!wait) return;
  const retryAt = wait.retryAt || (wait.waitMs ? new Date(Date.parse(at) + wait.waitMs).toISOString() : null);
  // Раундом ожидания был дедлайн, и на живом отказе это не работало: внутри
  // одного эпизода Pi объявляет то 5 с, то 15 с, а модель и причину называют
  // два источника одного ожидания — проза Pi и машинный кадр pi-limits-wait.
  // Ключ менялся на каждом тике, и на один отказ 2026-10-12 в чат уходило три
  // заметки («Провайдер не принял запрос: fetch failed», «… через 15 с»,
  // «Провайдер openai-codex/gpt-5.6-sol …») — оператор видел ошибку там, где
  // субагент ещё работал. Эпизод называет сам машинный кадр (`periodId`), а
  // прозу того же эпизода привязываем по виду отказа и модели.
  if (sameProviderWait(task.providerWait, wait)) {
  // Тик не перезаписывает объявленное: остаток до повтора клиент считает от
  // `retryAt`, а `waitMs` и текст сообщения — снимок начала раунда.
    task.providerWait = { ...task.providerWait, at, periodId: task.providerWait.periodId || wait.periodId || null };
    task.current = providerWaitCurrent(task.providerWait);
    return;
  }
  const next = { ...wait, retryAt, at, since: wait.since || task.providerWait?.since || at };
  task.providerWait = next;
  task.current = providerWaitCurrent(next);
  await emit('PROVIDER_WAIT', providerWaitMessage(next), { ...next, waiting: true });
}

/**
 * Ожидание кончилось: провайдер ответил, Pi ушёл или ход закончился. Состояние
 * не должно пережить своё событие — иначе в диагностике через сутки всё ещё
 * написано «ждём провайдера».
 */
export async function clearProviderWait(task, reason, emit, { announce = true } = {}) {
  const had = Boolean(task.providerWait);
  task.providerWait = null;
  if (String(task.current || '').startsWith(PROVIDER_WAIT_CURRENT)) task.current = '';
  if (had && announce) await emit('PROVIDER_WAIT_END', 'Провайдер снова отвечает', { reason });
}
