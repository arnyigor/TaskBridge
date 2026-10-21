// Детерминированная оценка прогонов A/B (§ MR-05).
//
// Никакого LLM-as-judge в основе: правильность ответа решают факты — найден ли
// путь в выводе инструмента, назван ли он в ответе, были ли записи и утверждения
// без подтверждения. Модель оценки не должна зависеть от модели, которую меряют.
//
// Всё, что здесь есть, — чистые функции: run.mjs только собирает факты, тест
// (tests/agent-behavior.test.mjs) проверяет оценку на записанных прогонах, не
// запуская ни одной модели.

const WRITE_TOOLS = new Set(['write', 'edit', 'create', 'apply_patch', 'multiedit', 'notebookedit']);

const CALL_RANK = { taskSuccess: 0, profileAccuracy: 1, unnecessaryCalls: 2, unnecessaryWrites: 3 };

const normalize = value => String(value ?? '').replaceAll('\\', '/').toLowerCase();
const squash = value => normalize(value).replace(/\s+/g, ' ');

/** Профиль, который ушёл в Pi: `Task instructions (quick)`. У варианта A его нет. */
export function profileOf(prompt) {
  const match = /Task instructions \((\w+)\)/.exec(String(prompt || ''));
  return match ? match[1].toLowerCase() : null;
}

const baseName = value => String(value || '').replace(/\/+$/, '').split('/').pop();

/**
 * Утверждения, которые ответ не может подтвердить: числа с единицами (ГБ, уроков,
 * файлов), которых нет в выводе инструментов. Именно такой случай и был в живом
 * инциденте — «9,0 ГБ, 32+ урока» без `du`.
 */
export function unsupportedClaims(answer, outputs) {
  const text = String(answer || '');
  const evidence = squash(outputs);
  const claims = [];
  const pattern = /(\d+(?:[.,]\d+)?)\s*(гб|мб|кб|тб|урок\w*|файл\w*|видео|gb|mb|kb|tb|lessons?|files?)/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const number = match[1].replace(',', '.');
    // Число считается подтверждённым, если оно есть в выводе инструментов с той
    // же единицей или без неё (du -sh печатает «9.0G»).
    const bare = new RegExp(`(^|[^0-9.,])${number.replace('.', '[.,]')}([^0-9]|$)`);
    if (!bare.test(evidence) && !evidence.includes(match[0].toLowerCase())) claims.push(match[0].trim());
  }
  return claims;
}

/**
 * Один прогон одного сценария → метрики.
 *
 * run: {
 *   scenarioId, variant, model, commit, status, errorCode,
 *   elapsedMs, totalTokens, prompt, answer,
 *   toolCalls: [{ toolName, target, isError, output }]
 * }
 */
export function evaluateRun(scenario, run) {
  const expect = scenario.expect || {};
  const calls = Array.isArray(run.toolCalls) ? run.toolCalls : [];
  const outputs = calls.map(call => String(call.output || ''));
  const answer = String(run.answer || '');
  const profile = profileOf(run.prompt);

  // Где подтвердилось: первый вызов, в выводе которого есть ожидаемый путь —
  // или все ожидаемые имена сразу (для неоднозначности это и значит «вскрыта»).
  const toolMarkers = expect.path ? [baseName(expect.path)] : (expect.ambiguous || []);
  let confirmedAt = -1;
  if (toolMarkers.length) {
    confirmedAt = calls.findIndex(call => {
      const output = squash(call.output);
      return toolMarkers.every(marker => output.includes(squash(marker)));
    });
  }
  const foundInTools = confirmedAt >= 0;

  const missing = expect.found === false;
  const answerMarkers = [...toolMarkers, ...(expect.mentions || [])];
  const answerText = squash(answer);
  const foundInAnswer = answerMarkers.length > 0 && answerMarkers.every(marker => answerText.includes(squash(marker)));

  const writes = calls.filter(call => WRITE_TOOLS.has(String(call.toolName || '').toLowerCase())).length;
  const unnecessaryWrites = expect.writesAllowed ? 0 : writes;

  const declaredMax = Number.isFinite(expect.maxCalls) ? expect.maxCalls : null;
  const unnecessaryCalls = foundInTools
    ? Math.max(0, calls.length - (confirmedAt + 1))
    : (declaredMax != null ? Math.max(0, calls.length - declaredMax) : 0);

  const claims = unsupportedClaims(answer, outputs);
  // Отсутствие должно быть названо словами: «нет», «не найден», «отсутствует».
  // Отрицание проверяется широко (`нет` в любом месте) — этого достаточно, чтобы
  // отличить «курса X нет» от «нашёл курс X», и не требует разбора предложения.
  const denied = missing ? /(нет|не найден|не нашёл|не обнаруж|отсутств|not found|no such)/i.test(answer) : true;
  const mentionsOk = (expect.mentions || []).every(marker => answerText.includes(squash(marker)));
  const foundOk = missing ? (!foundInTools && denied) : foundInTools;
  const answered = answer.trim().length > 0;
  const statusOk = run.status === 'SUCCEEDED';
  const writesOk = unnecessaryWrites === 0;
  const profileAccuracy = profile ? profile === expect.profile : null;

  const taskSuccess = Boolean(statusOk && foundOk && answered && mentionsOk && denied && writesOk
    && (profileAccuracy === null || profileAccuracy === true));

  return {
    scenarioId: scenario.id,
    category: scenario.category || null,
    variant: run.variant || null,
    model: run.model || null,
    status: run.status || null,
    errorCode: run.errorCode || null,
    profile,
    profileExpected: expect.profile || null,
    profileAccuracy,
    toolCalls: calls.length,
    unnecessaryCalls,
    writes,
    unnecessaryWrites,
    confirmedAt: confirmedAt >= 0 ? confirmedAt + 1 : null,
    foundInTools,
    foundInAnswer,
    mentionsOk,
    unsupportedClaims: claims,
    elapsedMs: Number.isFinite(run.elapsedMs) ? run.elapsedMs : null,
    totalTokens: Number.isFinite(run.totalTokens) ? run.totalTokens : null,
    taskSuccess,
    reasons: [
      statusOk ? null : `status=${run.status}`,
      foundOk ? null : (missing ? 'найдено то, чего нет' : 'путь не подтверждён инструментом'),
      answered ? null : 'пустой ответ',
      mentionsOk ? null : 'в ответе нет ожидаемых названий',
      denied ? null : 'отсутствие не названо словами',
      writesOk ? null : `записей без запроса: ${unnecessaryWrites}`,
      profileAccuracy === false ? `профиль ${profile} вместо ${expect.profile}` : null,
      claims.length ? `без подтверждения: ${claims.slice(0, 3).join(', ')}` : null,
    ].filter(Boolean),
  };
}

const mean = values => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const rate = (items, predicate) => (items.length ? items.filter(predicate).length / items.length : null);

/** Сводка по варианту: то, что сравнивается между A и B. */
export function summarize(metrics) {
  const byVariant = new Map();
  for (const item of metrics) {
    const key = item.variant || 'all';
    if (!byVariant.has(key)) byVariant.set(key, []);
    byVariant.get(key).push(item);
  }
  const out = {};
  for (const [variant, items] of byVariant) {
    const lookups = items.filter(item => item.category !== 'complex');
    const complex = items.filter(item => item.category === 'complex');
    out[variant] = {
      runs: items.length,
      successRate: rate(items, item => item.taskSuccess),
      lookupsSuccessRate: rate(lookups, item => item.taskSuccess),
      complexSuccessRate: rate(complex, item => item.taskSuccess),
      callsPerRun: mean(items.map(item => item.toolCalls)),
      unnecessaryCalls: mean(items.map(item => item.unnecessaryCalls)),
      unnecessaryWrites: items.reduce((sum, item) => sum + item.unnecessaryWrites, 0),
      unsupportedClaims: items.reduce((sum, item) => sum + item.unsupportedClaims.length, 0),
      profileAccuracy: rate(items.filter(item => item.profileAccuracy !== null), item => item.profileAccuracy),
      elapsedMs: mean(items.map(item => item.elapsedMs).filter(Number.isFinite)),
      totalTokens: mean(items.map(item => item.totalTokens).filter(Number.isFinite)),
    };
  }
  return out;
}

/** Критерии приёмки MR-05 в виде вердиктов, а не «на глаз». */
export function verdicts(summary) {
  const a = summary.A || null;
  const b = summary.B || null;
  if (!a || !b) return [{ id: 'both-variants', ok: false, detail: 'нужны прогоны A и B' }];
  const num = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
  return [
    {
      id: 'quality-not-worse',
      ok: num(b.lookupsSuccessRate) >= num(a.lookupsSuccessRate),
      detail: `поиск A ${fmt(a.lookupsSuccessRate)} → B ${fmt(b.lookupsSuccessRate)}`,
    },
    {
      id: 'no-unrequested-writes',
      ok: b.unnecessaryWrites === 0,
      detail: `записей без запроса: B ${b.unnecessaryWrites}, A ${a.unnecessaryWrites}`,
    },
    {
      id: 'fewer-unnecessary-calls',
      ok: num(b.unnecessaryCalls) < num(a.unnecessaryCalls),
      detail: `лишних вызовов в среднем: A ${fmt(a.unnecessaryCalls)} → B ${fmt(b.unnecessaryCalls)}`,
    },
    {
      id: 'complex-not-cut',
      ok: num(b.complexSuccessRate) >= num(a.complexSuccessRate),
      detail: `сложные задачи A ${fmt(a.complexSuccessRate)} → B ${fmt(b.complexSuccessRate)}`,
    },
    {
      id: 'no-unsupported-claims',
      ok: b.unsupportedClaims <= a.unsupportedClaims,
      detail: `утверждений без подтверждения: A ${a.unsupportedClaims} → B ${b.unsupportedClaims}`,
    },
  ];
}

const fmt = value => (value == null ? '—' : `${Math.round(value * 1000) / 1000}`);

export function toMarkdown({ summary, metrics, verdictList, meta = {} }) {
  const lines = [];
  lines.push('# Agent behaviour A/B');
  lines.push('');
  if (meta.generatedAt) lines.push(`Прогон: ${meta.generatedAt}`);
  if (meta.model) lines.push(`Модель: ${meta.model}`);
  if (meta.benchVersion) lines.push(`Сценарии: v${meta.benchVersion}`);
  lines.push('');
  lines.push('## Сводка');
  lines.push('');
  lines.push('| Метрика | A (до PromptBuilder) | B (PromptBuilder) |');
  lines.push('| --- | --- | --- |');
  const a = summary.A || {};
  const b = summary.B || {};
  const row = (label, key, transform = fmt) => lines.push(`| ${label} | ${transform(a[key])} | ${transform(b[key])} |`);
  row('Прогонов', 'runs');
  row('Успешно, всё', 'successRate');
  row('Успешно, поиск', 'lookupsSuccessRate');
  row('Успешно, сложные', 'complexSuccessRate');
  row('Вызовов на прогон', 'callsPerRun');
  row('Лишних вызовов', 'unnecessaryCalls');
  row('Записей без запроса', 'unnecessaryWrites');
  row('Утверждений без подтверждения', 'unsupportedClaims');
  row('Точность профиля', 'profileAccuracy');
  row('Время, мс', 'elapsedMs');
  row('Токенов на прогон', 'totalTokens');
  lines.push('');
  lines.push('## Критерии приёмки');
  lines.push('');
  for (const verdict of verdictList) lines.push(`- ${verdict.ok ? '✅' : '❌'} **${verdict.id}** — ${verdict.detail}`);
  lines.push('');
  lines.push('## Сценарии');
  lines.push('');
  lines.push('| Сценарий | Вариант | Успех | Профиль | Вызовов | Лишних | Записей | Без подтверждения | Причины |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const sorted = [...metrics].sort((x, y) => String(x.scenarioId).localeCompare(String(y.scenarioId)) || String(x.variant).localeCompare(String(y.variant)));
  for (const item of sorted) {
    lines.push(`| ${item.scenarioId} | ${item.variant} | ${item.taskSuccess ? '✅' : '❌'} | ${item.profile || '—'} | ${item.toolCalls} | ${item.unnecessaryCalls} | ${item.unnecessaryWrites} | ${item.unsupportedClaims.length} | ${item.reasons.join('; ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export { CALL_RANK };
