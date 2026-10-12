// Resume builder (ROADMAP_NEXT_1110.md, MR-04).
//
// A resumeContext is COMPUTED, never stored: it is what the next session needs
// right now, assembled from the work item, the sessions that did the work, their
// recaps, Git and the verification results. Nothing here copies a transcript —
// the whole point is that a new session starts short.

/**
 * The workspace choices the preview offers. `reuse` is implemented; «apply patch»
 * from the roadmap's sketch is NOT — automatically applying a patch to what
 * another session left behind is a destructive act, and a strategy that only
 * means «the operator will do it by hand» would be a lie in the UI.
 */
export const WORKSPACE_STRATEGIES = Object.freeze(['fresh-worktree', 'reuse']);

/** Where the project's long-term knowledge comes from. `native` means Pi's own memory; nothing is duplicated here. */
export const MEMORY_MODES = Object.freeze(['native', 'off']);

const CRITERIA_LIMIT = 50;
const SESSION_LIMIT = 20;
const FILE_LIMIT = 50;

const trim = (value, limit) => (value === null || value === undefined ? null : String(value).slice(0, limit));

/**
 * One previous session as the new one sees it: the recap (or what could be
 * derived), the files it touched and its verification — never its transcript.
 */
export function sessionSummary(session, { recap = null, diffBytes = null } = {}) {
  return {
    sessionId: session.sessionId,
    relation: session.relation,
    available: session.available !== false,
    title: trim(session.title, 200),
    prompt: trim(session.prompt, 200),
    status: session.status ?? null,
    updatedAt: session.updatedAt ?? null,
    recap,
    changedFiles: Array.isArray(session.changedFiles) ? session.changedFiles.slice(0, FILE_LIMIT) : [],
    verification: Array.isArray(session.verification) ? session.verification.slice(0, 20).map(entry => trim(entry, 300)) : [],
    diffBytes: Number.isFinite(diffBytes) ? diffBytes : null,
  };
}

/**
 * Assembles the context. Every input is already gathered by the caller: this
 * function is pure, which is what makes the preview and the launch agree (see
 * resume-validator.mjs for the re-check).
 */
export function buildResumeContext({
  workItem,
  sessions = [],
  workspace = {},
  verification = {},
  artifacts = [],
  memory = {},
  strategy = 'fresh-worktree',
} = {}) {
  if (!workItem) throw new Error('buildResumeContext needs a work item');
  if (!WORKSPACE_STRATEGIES.includes(strategy)) throw new Error(`Unknown workspace strategy: ${strategy}`);
  const memoryMode = MEMORY_MODES.includes(memory.mode) ? memory.mode : 'native';
  return {
    workItem: {
      id: workItem.id,
      title: workItem.title,
      goal: trim(workItem.goal, 2000),
      status: workItem.status,
      acceptanceCriteria: Array.isArray(workItem.acceptanceCriteria) ? workItem.acceptanceCriteria.slice(0, CRITERIA_LIMIT) : [],
    },
    previousSessions: sessions.slice(0, SESSION_LIMIT),
    workspace: {
      strategy,
      path: workspace.path ?? null,
      head: workspace.head ?? null,
      baseCommit: workspace.baseCommit ?? null,
      worktree: workspace.worktree === true,
      sourcePath: workspace.sourcePath ?? null,
      changedFiles: Array.isArray(workspace.changedFiles) ? workspace.changedFiles.slice(0, FILE_LIMIT) : [],
      truncated: workspace.truncated === true,
    },
    verification: {
      status: verification.status ?? null,
      commands: Array.isArray(verification.commands) ? verification.commands.slice(0, 20) : [],
    },
    relevantArtifacts: artifacts.slice(0, FILE_LIMIT).map(entry => ({
      sessionId: entry.sessionId ?? null,
      name: String(entry.name ?? ''),
      bytes: Number.isFinite(entry.bytes) ? entry.bytes : null,
    })),
    memory: {
      mode: memoryMode,
      ...(memory.overview ? { overview: memory.overview } : {}),
      ...(Array.isArray(memory.hits) ? { hits: memory.hits.slice(0, 20).map(hit => ({
        id: hit.id ?? null,
        text: trim(hit.text, 2000),
        category: hit.category ?? 'other',
        source: hit.source ?? null,
        score: Number.isFinite(hit.score) ? hit.score : null,
        updatedAt: hit.updatedAt ?? null,
        provenance: hit.provenance ?? null,
        reason: hit.reason ?? null,
        estimatedTokens: Number.isFinite(hit.estimatedTokens) ? hit.estimatedTokens : null,
      })) } : {}),
      ...(Array.isArray(memory.warnings) ? { warnings: memory.warnings.slice(0, 20).map(warning => trim(warning, 300)) } : {}),
      ...(Number.isFinite(memory.estimatedTokens) ? { estimatedTokens: memory.estimatedTokens } : {}),
    },
  };
}

/**
 * A rough size of the rendered brief, so the preview can say what it costs before
 * the operator starts anything. Same chars/4 heuristic Pi uses (`estimateTokens`).
 */
export function estimateContextTokens(context) {
  const chars = JSON.stringify(context).length;
  return Math.ceil(chars / 4);
}
