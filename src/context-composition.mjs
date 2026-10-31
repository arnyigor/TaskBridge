// Что модель видит после сжатия (CTX-02).
//
// Считается по уже разобранной сессии Pi (`readPiSession`): его `messages` — это
// активный контекст (сводка сжатия + сохранённый кусок истории + всё, что пришло
// после), а `branchMessages` — вся выбранная ветка, включая то, что из контекста
// исключено. Модуль только считает: ни файлов, ни сети.
//
// По умолчанию отдаются ТОЛЬКО метаданные и размеры. Текст сводки или сообщений
// здесь не возвращается вовсе: экран должен сначала показать, из чего контекст
// состоит, и лишь по отдельному действию пользователя запросить содержимое.
//
// Важная оговорка, которую нельзя терять: это проекция по файлу сессии, а не
// `SessionManager.buildSessionContext()` самого Pi. Проекция ветки, context_edit
// и checkpoint сверена с Pi 1.4.0, но размер запроса зависит ещё от системных
// секций и инструментов, поэтому это реконструкция, а не токенизация.

const textOf = message => {
  if (!message) return '';
  if (message.role === 'compactionSummary' || message.role === 'branchSummary') return String(message.summary || '');
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map(part => (part?.type === 'text' ? part.text || '' : part?.type === 'thinking' ? part.thinking || ''
      : part?.type === 'toolCall' ? JSON.stringify(part.arguments ?? {}) : ''))
    .join('');
};

const chars = message => textOf(message).length;

function countTools(message) {
  if (!Array.isArray(message?.content)) return { calls: 0, results: 0 };
  let calls = 0;
  let results = 0;
  for (const part of message.content) {
    if (part?.type === 'toolCall') calls += 1;
    if (part?.type === 'toolResult') results += 1;
  }
  return { calls, results };
}

/** Одна запись активного контекста → то, что разрешено показывать. */
function describe(role, message, timestamp = null) {
  const tools = role === 'toolResult'
    ? { calls: 0, results: 1 }
    : role === 'assistant' ? countTools(message) : { calls: 0, results: 0 };
  return {
    role,
    timestamp,
    chars: chars(message),
    summaryChars: role === 'compactionSummary' ? String(message?.summary ?? '').length : 0,
    toolCalls: tools.calls,
    toolResults: tools.results,
  };
}

/**
 * Снимок системного промпта из записи compaction.
 *
 * Pi 1.4.0 сохраняет в `CompactionEntry.systemMessage` копию системного
 * промпта и объявленных инструментов на момент сжатия (`session-manager.js`:
 * `entry.systemMessage ? [entry.systemMessage, summary] : [summary]`), и эта
 * копия участвует в каждом следующем запросе. Для реальной сессии это 60 586
 * символов ≈ 15K токенов: preamble 2 228, project_context 12 217, skills 10 503,
 * toolsAdded 34 898 (36 инструментов). Поэтому её размер обязан быть виден в
 * отчёте отдельно: без этого он молча попадает в «прочие источники».
 *
 * `tools` — имена, объявленные в снимке; `staleTools` — те из них, которые
 * сейчас отключены или исключены (отключённый MCP-инструмент остаётся в тексте
 * старого снимка, хотя модель вызвать его больше не может). Сравнение идёт
 * только с известными MCP-инструментами: список встроенных инструментов Pi
 * снаружи не читается, и выдумывать его здесь нельзя.
 */
function systemSnapshotOf(message, toolNames = {}) {
  if (!message || message.role !== 'system') return null;
  const sections = {};
  for (const [name, value] of Object.entries(message.sections || {})) {
    if (typeof value === 'string') sections[name] = value.length;
  }
  const sectionsChars = Object.values(sections).reduce((sum, value) => sum + value, 0);
  const contentChars = typeof message.content === 'string' ? message.content.length : 0;
  const tools = Array.isArray(message.toolsAdded)
    ? message.toolsAdded.map(tool => (typeof tool === 'string' ? tool : tool?.name)).filter(name => typeof name === 'string')
    : [];
  const toolChars = Array.isArray(message.toolsAdded) ? JSON.stringify(message.toolsAdded).length : 0;
  const known = Array.isArray(toolNames?.managed) ? new Set(toolNames.managed) : null;
  const enabled = Array.isArray(toolNames?.enabled) ? new Set(toolNames.enabled) : null;
  return {
    chars: sectionsChars + contentChars + toolChars,
    sections,
    tools,
    toolChars,
    // Только когда набор известен: иначе «устаревших» не бывает.
    staleTools: known && enabled ? tools.filter(name => known.has(name) && !enabled.has(name)) : null,
  };
}

/**
 * @param {{messages?: Array, branchMessages?: Array}} session результат readPiSession
 * @param {{managed?: string[], enabled?: string[]}} [options.availableTools]
 *   имена MCP-инструментов: известные адаптеру и фактически разрешённые сейчас
 * @returns метаданные состава активного контекста; никакого текста сообщений
 */
export function summarizeSessionContext(session = {}, options = {}) {
  const active = Array.isArray(session.messages) ? session.messages : [];
  const branch = Array.isArray(session.contextBranchMessages) ? session.contextBranchMessages
    : Array.isArray(session.branchMessages) ? session.branchMessages : [];
  const activeEntries = active.map(message => describe(message.role, message, message.timestamp ?? null));
  const compactionIndex = activeEntries.findIndex(entry => entry.role === 'compactionSummary');
  const summary = compactionIndex >= 0 ? activeEntries[compactionIndex] : null;
  const kept = compactionIndex >= 0 ? activeEntries.slice(compactionIndex + 1) : activeEntries;
  const totals = entries => entries.reduce((acc, entry) => ({
    messages: acc.messages + 1,
    chars: acc.chars + entry.chars,
    toolCalls: acc.toolCalls + entry.toolCalls,
    toolResults: acc.toolResults + entry.toolResults,
  }), { messages: 0, chars: 0, toolCalls: 0, toolResults: 0 });
  const retainedCount = session.compaction?.keptMessages ?? null;
  const byRole = role => kept.filter(entry => entry.role === role).length;
  // Исключённое — то, что осталось в файле ветки, но в активный контекст не вошло.
  const excludedCount = Math.max(0, branch.length - active.length);
  return {
    // Потолок доверия к реконструкции должен быть виден клиенту.
    method: 'session-file-projection',
    projectionVersion: 'pi-1.4.0',
    branchSource: session.branchSource ?? 'file-tail',
    leafId: session.leafId ?? null,
    checkpoint: session.compaction?.checkpoint ?? null,
    // Снимок системного промпта, который Pi переигрывает после сжатия.
    systemSnapshot: systemSnapshotOf(active.find(message => message?.role === 'system'), options.availableTools),
    active: {
      total: totals(activeEntries), kept: totals(kept),
      retained: retainedCount === null ? null : totals(kept.slice(0, retainedCount)),
      added: retainedCount === null ? null : totals(kept.slice(retainedCount)),
      ignoredBeforeCompaction: typeof session.ignoredEntries === 'number' ? session.ignoredEntries : null,
    },
    compaction: summary ? {
      summaryChars: summary.summaryChars,
      // Сводку можно показать только по отдельному запросу: здесь её текста нет.
      summaryAvailable: summary.summaryChars > 0,
      firstKeptEntryId: session.firstKeptEntryId ?? null,
      tokensBefore: session.tokensBefore ?? null,
      at: session.compaction?.at ?? null,
      reason: session.compaction?.reason ?? null,
    } : null,
    history: {
      userMessages: byRole('user'),
      assistantMessages: byRole('assistant'),
      toolResults: kept.filter(entry => entry.role === 'toolResult').length,
      branchMessages: branch.length,
      excludedMessages: excludedCount,
      excludedChars: Math.max(0, totals(branch.map(message => describe(message.role, message))).chars - totals(activeEntries).chars),
    },
    // Системный промпт заново собирает Pi; в файле сессии лежит только снимок
    // момента сжатия (`systemSnapshot`), и он не заменяет текущие секции.
    note: 'Реконструкция по правилам Pi 1.4.0: ветка, context_edit и системный checkpoint учтены. Это не токенизация запроса. Без активного Pi выбрана последняя запись файла, а не подтверждённый runtime leaf. Текст сообщений и сводки загружается только по отдельному запросу.',
  };
}
