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

import { STEPS_SECTION, FINDINGS_SECTION, STEP_HEADING, FINDING_LINE, FIELD } from './plan-file.mjs';

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

/* ---------------- сборка управляемого плана из свободного текста ---------------- */

/**
 * ТЗ для модели: превратить свободный документ в плановый файл ровно того формата,
 * который принимает сервер. Формат перечислен целиком, потому что проверка строгая:
 * front matter, разделы «Шаги»/«Обнаруженные проблемы», шаг `### S-001 | TODO | P1 | …`,
 * обязательные критерии, результат только у DONE.
 */
export const PLAN_DRAFT_PROMPT = [
  'Ты превращаешь свободный документ в план работ TaskBridge.',
  'Инструментов у тебя нет: ничего не запускай и не изменяй.',
  'Ответ — ТОЛЬКО содержимое файла плана, без пояснений и без markdown-заборов.',
  'Формат строгий:',
  '---',
  'taskbridge_plan: 1',
  'plan_id: p-<латиница-цифры-дефисы>',
  'revision: 1',
  'goal: "<одна строка: чего добиться>"',
  '---',
  '',
  '# <заголовок плана>',
  '',
  '## Шаги',
  '',
  '### S-001 | TODO | P1 | <короткий заголовок шага>',
  '**Критерии:** <наблюдаемо, что считается выполненным>',
  '**Проверка:** <какой командой или действием это проверить>',
  '',
  '## Обнаруженные проблемы',
  '',
  'Правила: шаги только из текста, нумерация S-001, S-002, … по порядку; статус шага TODO;',
  'приоритет P0…P3; критерии обязательны у каждого шага; не выдумывай факты и файлы;',
  // Живой прогон 2026-10-29: живой план на 77 шагов был переписан в 13 шагов с нуля
  // и все статусы стали TODO. Если план уже есть, его нельзя сочинять заново.
  'Если во входе УЖЕ есть план (front matter taskbridge_plan: 1 и раздел «## Шаги»): не переписывай его.',
  'Сохрани в каждом шаге дословно id, статус, приоритет, заголовок, критерии, проверку, результат и происхождение;',
  'не перенумеровывай шаги и не меняй статусы. Убери только то, что планом не является:',
  'чужие разделы, прозу, таблицы, ссылки. Если в шаге не хватает критериев или проверки — дополни их из текста, шаг не удаляй.',
  'если в тексте нет работы, но есть заметки — сделай один шаг с честными критериями;',
  'раздел «Обнаруженные проблемы»: либо пусто, либо строки строго вида',
  '- F-001 | P1 | OPEN | <что не так>; свободный текст в этом разделе недопустим.'
].join('\n');

export function buildPlanDraftPrompt({ path: relPath = '', text = '', truncated = false, hint = '' } = {}) {
  return [
    PLAN_DRAFT_PROMPT,
    '',
    `Источник: ${relPath || '(без имени)'}${truncated ? ' (показано начало документа)' : ''}`,
    ...(hint ? [`Пожелание оператора: ${hint}`] : []),
    '---',
    String(text || ''),
    '---'
  ].join('\n');
}

/**
 * Достать из ответа модели сам файл плана: снимает заборы ```markdown и текст до
 * первого `---`, потому что модель почти всегда добавляет «Вот план:».
 */
export function extractManagedPlan(raw) {
  let text = String(raw || '').replace(/\r\n?/g, '\n').trim();
  // Заборы бывают и вокруг всего ответа, и после «Вот план:»: убираем строки-заборы.
  text = text.replace(/^```[a-zA-Z]*\s*$/gm, '').replace(/^```\s*$/gm, '').trim();
  const start = text.indexOf('---');
  if (start > 0) text = text.slice(start).trim();
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * Свободный текст в разделе «Обнаруженные проблемы» — частая вольность модели: по
 * сути это замечание, но формат требует `- F-001 | P1 | OPEN | …`, и строгая проверка
 * отвергала весь план целиком (живой прогон 2026-10-27 на реальном проекте). Текст
 * оператора не выбрасывается: он становится записью F-### с приоритетом P3.
 */
export function normalizeDraftIssues(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const header = lines.findIndex(line => /^##\s+Обнаруженные проблемы\s*$/.test(line.trim()));
  if (header < 0) return String(text || '');
  let lastNumber = 0;
  for (const line of lines.slice(header + 1)) {
    const match = /^\s*-\s*F-(\d+)\s*\|/.exec(line);
    if (match) lastNumber = Math.max(lastNumber, Number(match[1]));
  }
  const fixed = lines.map((line, index) => {
    if (index <= header) return line;
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (/^-\s*F-\d+\s*\|/.test(trimmed)) return line;
    if (trimmed.startsWith('#')) return line;
    lastNumber += 1;
    const body = trimmed.replace(/^[-*]\s*/, '').replace(/\s+/g, ' ').trim();
    if (!body) return line;
    return `- F-${String(lastNumber).padStart(3, '0')} | P3 | OPEN | ${body}`;
  });
  return fixed.join('\n');
}


/* ---------------- вырезка плана из документа без модели ---------------- */

/**
 * Убрать из документа всё, что не является планом, и оставить шаги как есть.
 *
 * Живой прогон 2026-10-29: оператор обновил живой план (77 шагов, 19 закрытых),
 * добавив раздел «## Корректировка по C++-плану» с прозой и таблицей. Строгая
 * проверка отказала всему файлу, а «Собрать план с помощью ИИ» переписало его в
 * 13 шагов с нуля: новые номера, все статусы TODO. Здесь та же работа делается
 * без модели и без потерь: front matter, заголовок, «## Шаги» с их полями и
 * «## Обнаруженные проблемы» остаются дословно, остальное отбрасывается.
 *
 * Возвращает `null`, если во входе нет управляемого плана: тогда это свободный
 * текст, и собирать план должна модель.
 */
export function stripToManagedPlan(input) {
  const lines = String(input || '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return null;
  const front = lines.slice(0, end + 1);
  if (!front.some(line => /^taskbridge_plan:\s*1\s*$/.test(line.trim()))) return null;

  const kept = [];
  const removed = [];
  let section = null;
  let sawStep = false;
  let sawFindings = false;
  for (const line of lines.slice(end + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ')) {
      section = trimmed.slice(3).trim();
      if (section === STEPS_SECTION || section === FINDINGS_SECTION) {
        if (section === FINDINGS_SECTION) sawFindings = true;
        kept.push(line);
      } else {
        removed.push(line);
      }
      continue;
    }
    if (!trimmed) {
      if (section === STEPS_SECTION || section === FINDINGS_SECTION) kept.push(line);
      continue;
    }
    if (trimmed.startsWith('# ')) {
      // Заголовок плана живёт до первого раздела; «# …» внутри раздела — уже текст.
      if (!section) kept.push(line); else removed.push(line);
      continue;
    }
    if (section === STEPS_SECTION) {
      const isStep = trimmed.startsWith('###') && STEP_HEADING.test(trimmed);
      if (isStep) sawStep = true;
      if (isStep || FIELD.test(trimmed)) kept.push(line); else removed.push(line);
      continue;
    }
    if (section === FINDINGS_SECTION) {
      if (trimmed.startsWith('-') && FINDING_LINE.test(trimmed)) kept.push(line); else removed.push(line);
      continue;
    }
    removed.push(line);
  }
  if (!sawStep) return null;

  const body = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
  const text = `${front.join('\n')}\n\n${body}\n${sawFindings ? '' : `\n## ${FINDINGS_SECTION}\n`}`;
  return { text, removed: removed.filter(line => line.trim()) };
}
