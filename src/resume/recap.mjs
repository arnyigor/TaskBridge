import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// Session recap (ROADMAP_NEXT_1110.md, «Этап 2. Session Recap»).
//
// The point of a recap is that a NEW session reads it instead of the whole
// transcript — that is where the token saving comes from. It is a small semantic
// document, not another database: it lives in the session's own artifacts
// (`recap.json` + `recap.md`), and nothing about it is stored in SQLite beyond
// the fact that the session has artifacts at all.
//
// Two sources, and the difference is visible on purpose:
//   - `derived`  — what TaskBridge knows for sure: the objective, the changed
//                  files, the verification results. No model, no invention.
//   - `saved`    — what an agent or the operator wrote (objective, accomplished,
//                  decisions, remaining, blockers). Semantic fields come from a
//                  model or a human, never from guessing.
// A derived recap may be incomplete; it is still honest, and `source` says so.

export const RECAP_JSON = 'recap.json';
export const RECAP_MD = 'recap.md';

const LIST_LIMIT = 50;
const ITEM_LIMIT = 500;
const FIELD_LIMIT = 4000;

// Verification in a recap is either OBSERVED by TaskBridge or CLAIMED by the
// session. The two must never look the same: «тесты прошли» said by an agent and
// a PASS that TaskBridge ran itself are different facts, and the whole point of
// the resume brief is that the next session can tell them apart.
//   passed       — TaskBridge ran it, it succeeded
//   failed       — TaskBridge ran it, it did not succeed
//   contradicted — the session claims success, TaskBridge observed a failure
//   reported     — the session says so and TaskBridge never observed it
//
// Итог: любое утверждение агента, которое TaskBridge не наблюдал, остаётся
// `reported` — оно попадает в новый контекст как слова, а не как истина.
export const VERIFICATION_STATUSES = Object.freeze(['passed', 'failed', 'reported', 'contradicted']);

/** True when the text asserts that something worked. */
function assertsSuccess(text) {
  return /\bpass(?:ed|es)?\b|\bok\b|успешн|прошл|зелён|✅/iu.test(String(text || ''));
}

/** The command part of a claim: «PASS: npm test» and «npm test» name the same thing. */
function claimToCommand(text) {
  return String(text || '')
    .replace(/^\s*(?:pass(?:ed|es)?|fail(?:ed)?|ok|прошл[аио]?|успешно)\s*[:\-—]\s*/iu, '')
    .replace(/^✅\s*/u, '')
    .trim();
}

/** Strings (written before statuses existed) are claims by definition. */
export function normalizeVerification(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(entry => {
      if (entry && typeof entry === 'object') {
        const text = String(entry.text ?? '').trim();
        if (!text) return null;
        const status = VERIFICATION_STATUSES.includes(entry.status) ? entry.status : 'reported';
        return { text: text.slice(0, ITEM_LIMIT), status };
      }
      const text = String(entry ?? '').trim();
      return text ? { text: text.slice(0, ITEM_LIMIT), status: 'reported' } : null;
    })
    .filter(Boolean)
    .slice(0, LIST_LIMIT);
}

/**
 * Marks the claims of a saved recap against what TaskBridge actually observed
 * (`task.verification`: `{ ok, command }`). A claim that names a command
 * TaskBridge ran — and the observation agrees — stops being a claim; a claim that
 * contradicts the observation says so instead of quietly looking verified. Everything
 * else stays `reported`.
 */
export function reconcileVerification(entries, observed = []) {
  const observedCommands = (Array.isArray(observed) ? observed : [])
    .filter(entry => entry && entry.command)
    .map(entry => ({ ok: entry.ok === true, command: String(entry.command), key: String(entry.command).trim().toLowerCase() }));
  return normalizeVerification(entries).map(entry => {
    const command = claimToCommand(entry.text).toLowerCase();
    if (!command) return entry;
    const match = observedCommands.find(item => item.key && (command.includes(item.key) || item.key.includes(command)));
    if (!match) return entry;
    if (match.ok) return { ...entry, status: 'passed' };
    // The session says «прошло», TaskBridge saw a failure: the contradiction is
    // the interesting part, and hiding it would be the one thing a recap must not do.
    return { ...entry, status: assertsSuccess(entry.text) ? 'contradicted' : 'failed' };
  });
}

/** Trims a list of short strings the way every other list in TaskBridge is trimmed. */
function stringList(value, itemLimit = ITEM_LIMIT) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, LIST_LIMIT)
    .map(item => item.slice(0, itemLimit));
}

/** The shape the roadmap asks for, with every field present (empty instead of absent). */
export function normalizeRecap(input = {}) {
  const text = (value) => {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    return trimmed ? trimmed.slice(0, FIELD_LIMIT) : null;
  };
  return {
    objective: text(input.objective),
    accomplished: stringList(input.accomplished),
    changedFiles: stringList(input.changedFiles, 300),
    decisions: stringList(input.decisions),
    verification: normalizeVerification(input.verification),
    remaining: stringList(input.remaining),
    blockers: stringList(input.blockers),
  };
}

const EMPTY = '— ничего не зафиксировано';

/** Markdown for a human, and the text a resume brief quotes. */
export function renderRecap(recap, { title = null } = {}) {
  const block = (heading, values) => `### ${heading}\n${values.length ? values.map(value => `- ${value}`).join('\n') : EMPTY}\n`;
  // `[status]` is part of the human-readable file too: a reader of recap.md must
  // see which lines TaskBridge confirmed and which are the session's word.
  const verification = (recap.verification || []).map(entry => `[${entry.status}] ${entry.text}`);
  return [
    title ? `# Recap: ${title}\n` : '# Recap\n',
    '## Objective',
    recap.objective || EMPTY,
    '',
    block('Done', recap.accomplished).trimEnd(),
    '',
    block('Changed files', recap.changedFiles).trimEnd(),
    '',
    block('Decisions', recap.decisions).trimEnd(),
    '',
    block('Verification', verification).trimEnd(),
    '',
    block('Remaining', recap.remaining).trimEnd(),
    '',
    block('Blockers', recap.blockers).trimEnd(),
    '',
  ].join('\n');
}

/**
 * What is known without asking a model: the objective from the session itself, the
 * files Git reported, and the verification outcomes. The semantic lists stay empty
 * — inventing them would be worse than an incomplete recap.
 */
export function deriveRecap(task, { recap = null } = {}) {
  if (recap && recap.source === 'saved') return recap;
  const changedFiles = Array.isArray(task?.git?.changedFiles) ? task.git.changedFiles : [];
  // Derived verification IS observed: TaskBridge ran these commands itself, so the
  // status is a result, not a claim.
  const verification = Array.isArray(task?.verification)
    ? task.verification.map(entry => ({
      text: `${entry?.ok ? 'PASS' : 'FAIL'}: ${entry?.command ?? '—'}`,
      status: entry?.ok ? 'passed' : 'failed',
    }))
    : [];
  const objective = (task?.title || task?.prompt || '').trim();
  return {
    recap: normalizeRecap({
      objective: objective ? objective.split('\n')[0].slice(0, 300) : null,
      changedFiles: changedFiles.slice(0, LIST_LIMIT),
      verification,
    }),
    source: 'derived',
  };
}

/** Reads `recap.json` from a session's artifacts, or null. Never throws: a missing or broken recap is not an error. */
export function readSavedRecap(taskDir) {
  if (!taskDir) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(taskDir, 'artifacts', RECAP_JSON), 'utf8'));
    const recap = normalizeRecap(parsed?.recap ?? parsed);
    return { recap, source: 'saved', updatedAt: parsed?.updatedAt ?? null };
  } catch {
    return null;
  }
}

/**
 * Writes the recap next to the session's other artifacts. The `source` is stored
 * inside the file so a reader can tell a model-written recap from a derived one
 * without asking the database.
 */
export async function writeRecap(taskDir, recap, { source = 'saved', updatedAt = new Date().toISOString() } = {}) {
  const normalized = normalizeRecap(recap);
  const dir = path.join(taskDir, 'artifacts');
  await fsp.mkdir(dir, { recursive: true });
  const payload = { source, updatedAt, ...normalized };
  await fsp.writeFile(path.join(dir, RECAP_JSON), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fsp.writeFile(path.join(dir, RECAP_MD), renderRecap(normalized), 'utf8');
  return payload;
}

export async function removeRecap(taskDir) {
  for (const name of [RECAP_JSON, RECAP_MD]) {
    await fsp.rm(path.join(taskDir, 'artifacts', name), { force: true }).catch(() => {});
  }
}
