// The preview (ROADMAP_NEXT_1110.md, MR-04).
//
// What the operator sees before pressing Start: a checklist of what will be in the
// new session, the choices that change it (workspace strategy, memory), how many
// files are involved and what it is going to cost. The preview is built from the
// SAME context object the launch sends, so the screen cannot promise one thing and
// the session receive another.

import { estimateContextTokens } from './resume-builder.mjs';

const MAX_LISTED_FILES = 20;

function check(present, label, detail = null) {
  return { label, present: present === true, detail: detail ?? null };
}

/**
 * @param context the object buildResumeContext produced
 * @param options.strategies the workspace strategies the server can actually offer
 */
export function buildResumePreview(context, { strategies = [], memoryModes = [], defaultStrategy = null } = {}) {
  const item = context.workItem;
  const sessions = context.previousSessions.filter(session => session.available !== false);
  const checklist = [
    check(Boolean(item.goal), 'Цель'),
    check(item.acceptanceCriteria.length > 0, 'Критерии готовности', item.acceptanceCriteria.length ? `${item.acceptanceCriteria.length}` : null),
  ];
  for (const session of sessions) {
    const recap = session.recap;
    const what = recap?.source === 'saved' ? 'recap сессии' : (recap?.objective ? 'сводка сессии' : 'сессия без итога');
    checklist.push(check(recap?.source === 'saved', session.title || session.prompt || session.sessionId, what));
  }
  checklist.push(check(Boolean(context.workspace.head), 'Состояние Git', context.workspace.head ? context.workspace.head.slice(0, 8) : null));
  checklist.push(check(context.verification.commands.length > 0, 'Проверки', context.verification.status ?? 'не запускались'));
  const files = new Set([
    ...context.workspace.changedFiles,
    ...sessions.flatMap(session => session.changedFiles),
  ]);

  return {
    workItem: item,
    checklist,
    // What is missing is as important as what is present: a session without a
    // recap means the new one will know less about it.
    warnings: [
      ...sessions.filter(session => !session.recap?.accomplished?.length).map(session => `у сессии ${session.sessionId} нет recap — новый агент не узнает, что в ней решено`),
      ...(context.workspace.truncated ? ['список изменённых файлов неполный (Git обрезал снимок)'] : []),
      ...(context.workspace.changedFiles.length === 0 && context.workspace.head ? [] : []),
    ],
    workspace: {
      strategy: context.workspace.strategy,
      strategies,
      defaultStrategy,
      path: context.workspace.path ?? null,
      head: context.workspace.head ?? null,
      changedFiles: context.workspace.changedFiles.slice(0, MAX_LISTED_FILES),
    },
    memory: {
      mode: context.memory.mode,
      modes: memoryModes,
      provider: context.memory.overview?.provider ?? null,
      status: context.memory.overview?.status ?? null,
      entries: context.memory.overview?.entries ?? null,
      selected: context.memory.hits?.length ?? 0,
      estimatedTokens: context.memory.estimatedTokens ?? null,
    },
    files: { count: files.size, listed: [...files].slice(0, MAX_LISTED_FILES) },
    sessions: sessions.map(session => ({
      sessionId: session.sessionId,
      relation: session.relation,
      title: session.title,
      status: session.status,
      recapSource: session.recap?.source ?? null,
    })),
    estimatedTokens: estimateContextTokens(context),
    promptChars: null,
  };
}
