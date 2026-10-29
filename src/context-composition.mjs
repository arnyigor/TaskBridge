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
 * @param {{messages?: Array, branchMessages?: Array}} session результат readPiSession
 * @returns метаданные состава активного контекста; никакого текста сообщений
 */
export function summarizeSessionContext(session = {}) {
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
    // Системный промпт и объявления инструментов в файле сессии не лежат — их
    // считает только отчёт по источникам (context-report.mjs).
    note: 'Реконструкция по правилам Pi 1.4.0: ветка, context_edit и системный checkpoint учтены. Это не токенизация запроса. Без активного Pi выбрана последняя запись файла, а не подтверждённый runtime leaf. Текст сообщений и сводки загружается только по отдельному запросу.',
  };
}
