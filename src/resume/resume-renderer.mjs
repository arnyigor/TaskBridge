// The brief a new session starts from (ROADMAP_NEXT_1110.md, MR-04).
//
// This text IS the prompt of the new session: the operator's «Start» sends it. It
// carries the work item, the criteria of done, what the previous sessions
// actually did, the state of the workspace and the verification results — and it
// deliberately does NOT carry the conversation. Anything the new session needs to
// read it can read itself, in the workspace it is given.

const MAX_SESSIONS = 8;
const MAX_CRITERIA = 20;
const MAX_FILES = 30;

function bulletList(values, empty = '—') {
  return values.length ? values.map(value => `- ${value}`).join('\n') : empty;
}

/** How a verification line is labelled for the new session. */
function verificationLabel(status) {
  switch (status) {
    case 'passed': return '[подтверждено TaskBridge]';
    case 'failed': return '[подтверждено TaskBridge: провал]';
    case 'contradicted': return '[противоречит наблюдению TaskBridge]';
    default: return '[со слов сессии]';
  }
}

/**
 * Renders the resume context as a prompt. [memoryNote] is passed in by the caller
 * so the wording stays where the memory mode is known; the default says the truth:
 * the project's long-term memory arrives by itself, nothing is copied into here.
 */
export function renderResumePrompt(context, { memoryNote = null } = {}) {
  const item = context.workItem;
  const lines = [];
  lines.push(`Продолжаем задачу: ${item.title}`);
  lines.push('');
  lines.push('## Что нужно сделать');
  lines.push(item.goal ? item.goal : '(цель не записана)');
  lines.push('');
  lines.push('## Критерии готовности');
  lines.push(bulletList(item.acceptanceCriteria.slice(0, MAX_CRITERIA), '— критерии не записаны'));
  lines.push('');

  const sessions = context.previousSessions.filter(session => session.available !== false).slice(0, MAX_SESSIONS);
  lines.push('## Что уже сделано в предыдущих сессиях');
  if (!sessions.length) {
    lines.push('— предыдущих сессий нет: это начало работы');
  } else {
    for (const session of sessions) {
      const head = `### ${session.title || session.prompt || session.sessionId}${session.status ? ` · ${session.status}` : ''}`;
      lines.push(head);
      const recap = session.recap;
      if (recap?.objective) lines.push(`Цель сессии: ${recap.objective}`);
      if (recap?.accomplished?.length) lines.push(`Сделано:\n${bulletList(recap.accomplished)}`);
      if (recap?.decisions?.length) lines.push(`Решения:\n${bulletList(recap.decisions)}`);
      if (recap?.remaining?.length) lines.push(`Осталось:\n${bulletList(recap.remaining)}`);
      if (recap?.blockers?.length) lines.push(`Блокеры:\n${bulletList(recap.blockers)}`);
      // A claim is marked as a claim: «тесты прошли» said by a session is not the
      // same fact as a PASS TaskBridge ran itself, and the new session must not
      // treat the first as the second.
      if (recap?.verification?.length) {
        lines.push(`Проверки сессии:\n${bulletList(recap.verification.map(entry => `${verificationLabel(entry.status)} ${entry.text}`))}`);
      }
      if (session.changedFiles.length) lines.push(`Файлы: ${session.changedFiles.slice(0, MAX_FILES).join(', ')}`);
      // The files are facts, not a summary: without a recap the new session still
      // does not know what was decided here, and it must be told so.
      if (!recap?.accomplished?.length && !recap?.remaining?.length) {
        lines.push('— итог этой сессии не зафиксирован (recap не сохранён): известно только то, что перечислено выше');
      }
      lines.push('');
    }
  }

  const workspace = context.workspace;
  lines.push('## Рабочая папка');
  lines.push(`Стратегия: ${workspace.strategy}`);
  if (workspace.path) lines.push(`Путь: ${workspace.path}`);
  if (workspace.head) lines.push(`HEAD: ${workspace.head}`);
  if (workspace.changedFiles.length) {
    lines.push(`Незакоммиченные изменения: ${workspace.changedFiles.slice(0, MAX_FILES).join(', ')}${workspace.truncated ? ' (список неполный)' : ''}`);
  }
  lines.push('');

  lines.push('## Проверки');
  if (context.verification.status) lines.push(`Статус: ${context.verification.status}`);
  lines.push(bulletList(
    context.verification.commands.map(entry => `${entry.ok ? 'PASS' : 'FAIL'}: ${entry.command}`),
    '— проверки не запускались',
  ));
  lines.push('');

  if (context.relevantArtifacts.length) {
    lines.push('## Артефакты предыдущих сессий');
    lines.push(bulletList(context.relevantArtifacts.slice(0, MAX_FILES).map(entry => `${entry.name}${entry.sessionId ? ` (сессия ${entry.sessionId})` : ''}`)));
    lines.push('');
  }

  lines.push('## Память проекта');
  if (memoryNote) {
    lines.push(memoryNote);
  } else if (context.memory.mode === 'off') {
    lines.push('Долговременная память проекта отключена для этой сессии.');
  } else if (context.memory.hits?.length) {
    lines.push('Ниже только выбранные релевантные выдержки из project memory; это подсказки, а не истина проекта.');
    for (const hit of context.memory.hits) {
      lines.push(`- [${hit.category || 'other'}] ${hit.text}${hit.source ? ` (source: ${hit.source})` : ''}${hit.reason ? ` — ${hit.reason}` : ''}`);
    }
  } else if (context.memory.overview?.status === 'ambiguous') {
    lines.push('Долговременная память проекта не читается: папка памяти принадлежит не только этому репозиторию.');
  } else if (context.memory.overview?.status && context.memory.overview.status !== 'available') {
    lines.push('Долговременная память проекта недоступна этой сессии — продолжай по брифу.');
  } else {
    lines.push('Долговременная память проекта (pi-memory-md) подключается сама; релевантные выдержки не выбраны.');
  }
  if (context.memory.warnings?.length) lines.push(`Предупреждения памяти: ${context.memory.warnings.join('; ')}`);
  lines.push('');
  lines.push('## Как работать');
  lines.push('- Не пересказывай этот бриф и не повторяй работу из предыдущих сессий: она уже сделана.');
  lines.push('- Сверься с фактическим состоянием файлов и Git, прежде чем что-то менять: бриф — это память, а не истина.');
  lines.push('- Отвечай по-русски, коротко сообщая, что изменено и что проверено.');
  return lines.join('\n');
}
