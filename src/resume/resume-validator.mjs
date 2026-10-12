// The launch-time re-check (ROADMAP_NEXT_1110.md, MR-04: «Preview ≠ Launch»).
//
// What the operator saw in the preview and what the new session will actually get
// are two different moments, and the machine can move in between: HEAD changes, a
// worktree disappears, an artifact is deleted, a session is forgotten. The
// launch therefore re-reads the same facts and compares them with the preview. A
// mismatch is not a crash: it is a refusal with the list of what changed, so the
// operator decides again.

import { WORKSPACE_STRATEGIES, MEMORY_MODES } from './resume-builder.mjs';

/**
 * The fingerprint of a preview: exactly the facts the launch has to find again.
 * Kept small and comparable — it travels to the client and back.
 */
export function contextFingerprint(context) {
  return {
    workItemId: context.workItem?.id ?? null,
    head: context.workspace?.head ?? null,
    worktreePath: context.workspace?.path ?? null,
    strategy: context.workspace?.strategy ?? null,
    memory: context.memory?.mode ?? null,
    memoryStatus: context.memory?.overview?.status ?? null,
    memoryHits: (context.memory?.hits ?? []).map(hit => hit.id || hit.source || hit.text).filter(Boolean).sort(),
    sessionIds: (context.previousSessions ?? []).map(session => session.sessionId).sort(),
    artifacts: (context.relevantArtifacts ?? []).map(entry => `${entry.sessionId ?? ''}:${entry.name}`).sort(),
  };
}

/**
 * Compares the preview with the facts read now. Returns `{ ok, changes: [] }`;
 * every change names the field and both values, because «context changed» alone
 * tells the operator nothing about what to do.
 */
export function validateResume({ preview, current, requested = {} } = {}) {
  const changes = [];
  const before = preview ?? {};
  const now = current ?? {};

  if (requested.strategy !== undefined && !WORKSPACE_STRATEGIES.includes(requested.strategy)) {
    changes.push({ field: 'strategy', reason: 'unknown', was: before.strategy ?? null, now: requested.strategy });
  }
  if (requested.memory !== undefined && !MEMORY_MODES.includes(requested.memory)) {
    changes.push({ field: 'memory', reason: 'unknown', was: before.memory ?? null, now: requested.memory });
  }

  if (before.workItemId && now.workItemId && before.workItemId !== now.workItemId) {
    changes.push({ field: 'workItem', reason: 'different', was: before.workItemId, now: now.workItemId });
  }
  if ((before.head ?? null) !== (now.head ?? null)) {
    changes.push({ field: 'workspace.head', reason: 'moved', was: before.head ?? null, now: now.head ?? null });
  }
  if ((before.worktreePath ?? null) !== (now.worktreePath ?? null)) {
    changes.push({ field: 'workspace.path', reason: 'missing', was: before.worktreePath ?? null, now: now.worktreePath ?? null });
  }
  if ((before.strategy ?? null) !== (now.strategy ?? null)) {
    changes.push({ field: 'workspace.strategy', reason: 'changed', was: before.strategy ?? null, now: now.strategy ?? null });
  }

  const goneSessions = (before.sessionIds ?? []).filter(id => !(now.sessionIds ?? []).includes(id));
  if (goneSessions.length) {
    changes.push({ field: 'sessions', reason: 'disappeared', was: goneSessions, now: now.sessionIds ?? [] });
  }
  const goneArtifacts = (before.artifacts ?? []).filter(name => !(now.artifacts ?? []).includes(name));
  if (goneArtifacts.length) {
    changes.push({ field: 'artifacts', reason: 'disappeared', was: goneArtifacts, now: now.artifacts ?? [] });
  }
  if ((before.memory ?? null) !== (now.memory ?? null)) {
    changes.push({ field: 'memory', reason: 'changed', was: before.memory ?? null, now: now.memory ?? null });
  }
  if ((before.memoryStatus ?? null) !== (now.memoryStatus ?? null)) {
    changes.push({ field: 'memory.status', reason: 'changed', was: before.memoryStatus ?? null, now: now.memoryStatus ?? null });
  }
  const beforeMemoryHits = before.memoryHits ?? [];
  const nowMemoryHits = now.memoryHits ?? [];
  const memoryHitsChanged = beforeMemoryHits.length !== nowMemoryHits.length
    || beforeMemoryHits.some((id, index) => id !== nowMemoryHits[index]);
  if (memoryHitsChanged) {
    changes.push({ field: 'memory.hits', reason: 'changed', was: beforeMemoryHits, now: nowMemoryHits });
  }

  return { ok: changes.length === 0, changes };
}

/** A sentence for the dialog: what moved and how. */
export function describeChanges(changes) {
  return changes
    .map(change => {
      switch (`${change.field}:${change.reason}`) {
        case 'workspace.head:moved':
          return `HEAD сдвинулся: было ${String(change.was).slice(0, 8)}, стало ${String(change.now).slice(0, 8)}`;
        case 'workspace.path:missing':
          return `рабочая папка исчезла: ${change.was}`;
        case 'workspace.strategy:changed':
          return `стратегия рабочей папки изменилась: ${change.was} → ${change.now}`;
        case 'sessions:disappeared':
          return `сессии из превью больше нет: ${[].concat(change.was).join(', ')}`;
        case 'artifacts:disappeared':
          return `артефакт из превью удалён: ${[].concat(change.was).join(', ')}`;
        case 'workItem:different':
          return 'задача в превью — другая';
        case 'memory:changed':
          return `режим памяти изменился: ${change.was} → ${change.now}`;
        case 'memory.status:changed':
          return `состояние памяти изменилось: ${change.was ?? '—'} → ${change.now ?? '—'}`;
        case 'memory.hits:changed':
          return 'выбранные записи памяти изменились';
        default:
          return `${change.field}: ${change.reason} (${change.was ?? '—'} → ${change.now ?? '—'})`;
      }
    })
    .join('; ');
}
