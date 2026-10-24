// Необязательная проверка выбранного файла моделью (FP-UX-04E).
//
// Правила, из которых здесь нет исключений:
//   * только по явному нажатию оператора: ни выбор файла, ни сканирование, ни
//     подключение плана модель не спрашивают;
//   * модель не запускает Follow Plan и не получает инструментов: это один
//     запрос «похож ли текст на исполнимый план» и ничего больше;
//   * текст ограничен по объёму, а число запросов — по времени (см. limits);
//   * ответ модели — совет. Структурную проверку (classifyPlan) он не заменяет и
//     содержимое файла не переписывает даже при согласии оператора;
//   * конфиденциальность: в ответ попадает, какая модель отвечала и локальная ли
//     она — в облако текст уходит только так, как уходит любой ход этой сессии.

export const AI_REVIEW_LIMITS = Object.freeze({
  // Больше 12 000 символов модель читает дольше, чем оператор ждёт, и это уже не
  // «проверить файл», а «пересказать проект».
  maxChars: 12_000,
  maxTokens: 400,
  timeoutMs: 30_000,
  requestsPerMinute: 3
});

export const PLAN_REVIEW_PROMPT = [
  'Ты проверяешь, является ли Markdown-документ исполняемым планом работ.',
  'Инструментов у тебя нет: ничего не запускай и не изменяй.',
  'План — это цель и список конкретных шагов с наблюдаемыми критериями выполнения.',
  'Обычная документация, README, заметки и оглавление планом не являются.',
  'Ответь ОДНИМ JSON-объектом без пояснений вокруг:',
  '{"looksLikePlan":true|false,"verdict":"PLAN"|"NOT_PLAN"|"UNCLEAR","reasons":["до трёх коротких причин"]}'
].join('\n');

export function buildPlanReviewPrompt({ path: relPath = '', text = '', truncated = false } = {}) {
  return [
    PLAN_REVIEW_PROMPT,
    '',
    `Файл: ${relPath || '(без имени)'}${truncated ? ' (показано начало файла)' : ''}`,
    '---',
    String(text || ''),
    '---'
  ].join('\n');
}

/**
 * Разбор ответа модели. Мусор, отказ и «пусто» — это `ok:false`, а не выдуманный
 * вердикт: совет, которого не было, хуже отсутствия совета.
 */
export function parsePlanReviewAnswer(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, code: 'EMPTY_ANSWER', message: 'Модель ответила пустым сообщением.' };
  // Модели заворачивают JSON в ```json или в текст вокруг него.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? text.slice(start, end + 1) : text;
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, code: 'UNPARSABLE', message: 'Ответ модели не разобран как JSON.' };
  }
  const verdict = ['PLAN', 'NOT_PLAN', 'UNCLEAR'].includes(parsed?.verdict) ? parsed.verdict : null;
  const looksLikePlan = typeof parsed?.looksLikePlan === 'boolean' ? parsed.looksLikePlan : null;
  if (!verdict && looksLikePlan === null) {
    return { ok: false, code: 'UNPARSABLE', message: 'В ответе модели нет ни verdict, ни looksLikePlan.' };
  }
  const reasons = Array.isArray(parsed?.reasons)
    ? parsed.reasons.map(reason => String(reason || '').trim()).filter(Boolean).slice(0, 3)
    : [];
  return {
    ok: true,
    verdict: verdict || (looksLikePlan ? 'PLAN' : 'NOT_PLAN'),
    looksLikePlan: looksLikePlan === null ? verdict === 'PLAN' : looksLikePlan,
    reasons
  };
}
