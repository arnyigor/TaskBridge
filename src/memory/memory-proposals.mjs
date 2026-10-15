import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { MEMORY_CATEGORIES } from './project-memory-provider.mjs';
import { anyPathExists, missingPaths, projectFileIndex } from './path-patterns.mjs';

// Memory Suggestions (MEM-08, 2026-10-12).
//
// The gap this closes: a read-only memory never learns, and a memory an AGENT can
// write to directly fills up with today's guesswork. So there is exactly one write
// path, and it is not the agent's:
//
//   agent/session  →  предложение (изолированный буфер)  →  детерминированная
//                                                             проверка  →  человек
//                                                             → core/pi-memory-md
//
// A proposal is a FILE in `<memory>/.memory-proposals/` — a sibling of `core/`, and
// pi-memory-md scans only `core`, so an unconfirmed proposal is physically incapable
// of reaching a model. Acceptance is the only thing that writes into `core`, and it
// refuses unless the deterministic checks pass: no empty text, no unknown category,
// no duplicate of what the project already knows, no declared path that does not
// exist (a note stale from birth is worse than no note), no secret-looking payload.
//
// Nothing here is semantic: every rejection is a fact, reproducible from the files.

export const PROPOSAL_STATUSES = Object.freeze(['proposed', 'accepted', 'rejected']);

const PROPOSALS_DIR = '.memory-proposals';
const TEXT_LIMIT = 4000;
const REASON_LIMIT = 1000;
const LIST_LIMIT = 200;
const MAX_PATHS = 20;
const REFUSAL_LIMIT = 20;

// Shapes that must never be proposed as «project knowledge». This is a FILTER, not
// a guarantee: it exists so the obvious cases never reach a human for approval, and
// the human is still the gate for everything else.
const SECRET_SHAPES = [
  /\bsk-[A-Za-z0-9]{16,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\b(?:ghp|gho|ghs|glpat|xox[baprs])-[A-Za-z0-9_-]{16,}/u,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./u,
  /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_\-+/=]{16,}/iu,
];

export function proposalsDir(memoryDir) {
  return path.join(memoryDir, PROPOSALS_DIR);
}

function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function shortId() {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 12);
}

/** A filename that stays inside the proposals directory whatever the title was. */
function slugOf(value, fallback) {
  const ascii = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48);
  return ascii || fallback;
}

function stringList(value, limit, itemLimit) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, limit)
    .map(item => item.slice(0, itemLimit));
}

/**
 * The deterministic gate. Returns `{ ok, problems: [{ code, message }] }`; an empty
 * problem list is the ONLY way something reaches `core/`.
 *
 * @param input       what someone proposes
 * @param existingText normalized texts the project already knows (duplicates)
 * @param projectPath the project root, for the declared-path check
 * @param fileIndex   the project's file list (`projectFileIndex`), so declared
 *                    PATTERNS are checked the same way staleness is
 */
export function validateProposal(input = {}, { existingText = [], projectPath = null, fileIndex = null, memoryDir = null } = {}) {
  const problems = [];
  const text = String(input.text ?? '').trim();
  if (!text) problems.push({ code: 'EMPTY_TEXT', message: 'предложение без текста' });
  if (text.length > TEXT_LIMIT) problems.push({ code: 'TOO_LONG', message: `текст длиннее ${TEXT_LIMIT} символов` });
  if (input.category && !MEMORY_CATEGORIES.includes(input.category)) {
    problems.push({ code: 'UNKNOWN_CATEGORY', message: `категория — одна из: ${MEMORY_CATEGORIES.join(', ')}` });
  }
  const declared = stringList(input.paths, MAX_PATHS, 300);
  if (declared.length && projectPath && !anyPathExists(declared, { projectPath, index: fileIndex })) {
    const missing = missingPaths(declared, { projectPath, index: fileIndex });
    problems.push({ code: 'MISSING_PATHS', message: `ни одного из объявленных путей нет: ${missing.join(', ')}` });
  }
  if (existingText.includes(normalizeText(text))) {
    problems.push({ code: 'DUPLICATE', message: 'такое знание в памяти проекта уже есть' });
  }
  const hit = SECRET_SHAPES.find(shape => shape.test(text));
  if (hit) problems.push({ code: 'SECRET_SHAPE', message: 'текст похож на секрет или ключ' });
  // Замена должна указывать на существующую заметку: иначе «supersedes» ничего не
  // заменяет, и оператор думает, что старое знание выведено из контекста.
  const supersedes = typeof input.supersedes === 'string' ? input.supersedes.trim() : '';
  if (memoryDir && supersedes) {
    const target = path.join(memoryDir, supersedes);
    const insideCore = target.startsWith(path.join(memoryDir, 'core'));
    if (!insideCore || !fsSync.existsSync(target)) {
      problems.push({ code: 'SUPERSEDES_UNKNOWN', message: `заменяемая заметка не найдена: ${supersedes}` });
    }
  }
  return { ok: problems.length === 0, problems };
}

/** The file format: frontmatter a human can read, body as written. */
export function renderProposal(proposal) {
  const lines = [
    '---',
    `id: ${proposal.id}`,
    `status: ${proposal.status}`,
    `createdAt: ${proposal.createdAt}`,
    proposal.category ? `category: ${proposal.category}` : null,
    proposal.sourceSessionId ? `sourceSessionId: ${proposal.sourceSessionId}` : null,
    proposal.sourceWorkItemId ? `sourceWorkItemId: ${proposal.sourceWorkItemId}` : null,
    proposal.reason ? `reason: ${proposal.reason.replace(/\s+/gu, ' ')}` : null,
    proposal.paths?.length ? `paths: ${proposal.paths.join(', ')}` : null,
    proposal.supersedes ? `supersedes: ${proposal.supersedes}` : null,
    proposal.decidedAt ? `decidedAt: ${proposal.decidedAt}` : null,
    proposal.target ? `target: ${proposal.target}` : null,
    proposal.decisionReason ? `decisionReason: ${proposal.decisionReason.replace(/\s+/gu, ' ')}` : null,
    proposal.refusals?.length ? `refusals: ${proposal.refusals.join(', ')}` : null,
    proposal.lastRefusalAt ? `lastRefusalAt: ${proposal.lastRefusalAt}` : null,
    '---',
    '',
    proposal.text,
    '',
  ].filter(line => line !== null);
  return lines.join('\n');
}

/** Reads one proposal file back. Tolerant: a broken file is reported, not thrown. */
export function parseProposal(raw, file) {
  const source = path.basename(file);
  if (!raw.startsWith('---')) return null;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return null;
  const data = {};
  for (const line of raw.slice(4, end).split(/\r?\n/u)) {
    const match = /^(\w[\w-]*):\s*(.*)$/u.exec(line.trim());
    if (!match) continue;
    data[match[1]] = match[2].trim();
  }
  const text = raw.slice(raw.indexOf('\n', end + 1) + 1).trim();
  if (!data.id || !text) return null;
  return {
    id: data.id,
    source,
    status: PROPOSAL_STATUSES.includes(data.status) ? data.status : 'proposed',
    createdAt: data.createdAt ?? null,
    decidedAt: data.decidedAt ?? null,
    category: data.category ?? null,
    text,
    reason: data.reason ?? null,
    paths: data.paths ? data.paths.split(/[,\s]+/u).filter(Boolean) : [],
    supersedes: data.supersedes ? String(data.supersedes) : null,
    sourceSessionId: data.sourceSessionId ?? null,
    sourceWorkItemId: data.sourceWorkItemId ?? null,
    target: data.target ?? null,
    decisionReason: data.decisionReason ?? null,
    refusals: data.refusals ? data.refusals.split(/[,\s]+/u).filter(Boolean) : [],
    lastRefusalAt: data.lastRefusalAt ?? null,
  };
}

/** Every proposal of the project, newest first. A missing directory is not an error. */
export async function listProposals(memoryDir) {
  const dir = proposalsDir(memoryDir);
  const names = await fs.readdir(dir).catch(() => []);
  const proposals = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const raw = await fs.readFile(path.join(dir, name), 'utf8').catch(() => null);
    if (raw === null) continue;
    const parsed = parseProposal(raw, name);
    if (parsed) proposals.push(parsed);
  }
  return proposals
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.id.localeCompare(b.id))
    .slice(0, LIST_LIMIT);
}

/**
 * Writes a proposal into the isolated buffer. It never touches `core/`, so nothing
 * here can reach a model — the whole point of the buffer.
 */
export async function createProposal(memoryDir, input = {}, { now = new Date().toISOString() } = {}) {
  const text = String(input.text ?? '').trim().slice(0, TEXT_LIMIT);
  const id = `mp-${shortId()}`;
  const proposal = {
    id,
    status: 'proposed',
    createdAt: now,
    decidedAt: null,
    category: MEMORY_CATEGORIES.includes(input.category) ? input.category : 'other',
    text,
    reason: input.reason ? String(input.reason).trim().slice(0, REASON_LIMIT) : null,
    paths: stringList(input.paths, MAX_PATHS, 300),
    // M3: предложение может заменять существующее знание — адресуется путём заметки.
    supersedes: input.supersedes ? String(input.supersedes).trim().split('\\').join('/').slice(0, 300) : null,
    sourceSessionId: input.sourceSessionId ? String(input.sourceSessionId) : null,
    sourceWorkItemId: input.sourceWorkItemId ? String(input.sourceWorkItemId) : null,
    target: null,
    decisionReason: null,
    refusals: [],
    lastRefusalAt: null,
  };
  const dir = proposalsDir(memoryDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.md`), renderProposal(proposal), 'utf8');
  return proposal;
}

/**
 * Acceptance: the checks run FIRST, and only a clean proposal is written into
 * `core/project/`. A dirty one changes nothing anywhere and comes back with the
 * reasons — «ничего не сохранено» must be true, not implied.
 */
export async function acceptProposal(memoryDir, id, { existingText = [], projectPath = null, fileIndex = null, now = new Date().toISOString() } = {}) {
  const proposals = await listProposals(memoryDir);
  const proposal = proposals.find(entry => entry.id === id);
  if (!proposal) return { ok: false, code: 'NOT_FOUND', problems: [{ code: 'NOT_FOUND', message: 'предложение не найдено' }] };
  if (proposal.status !== 'proposed') {
    return { ok: false, code: 'ALREADY_DECIDED', problems: [{ code: 'ALREADY_DECIDED', message: `предложение уже ${proposal.status}` }] };
  }
  const verdict = validateProposal(proposal, { existingText, projectPath, fileIndex, memoryDir });
  if (!verdict.ok) {
    // Отказ не закрывает предложение, но записывается: по кодам видно, какие гейты
    // срабатывают часто. Это телеметрия качества памяти, а не наказание заявки.
    const codes = verdict.problems.map(problem => problem.code);
    const refused = {
      ...proposal,
      refusals: [...(proposal.refusals ?? []), ...codes].slice(-REFUSAL_LIMIT),
      lastRefusalAt: now,
    };
    await fs.writeFile(path.join(proposalsDir(memoryDir), proposal.source), renderProposal(refused), 'utf8').catch(() => {});
    return { ok: false, code: codes[0], problems: verdict.problems, refusals: refused.refusals };
  }

  const coreDir = path.join(memoryDir, 'core', 'project');
  const target = `core/project/${slugOf(proposal.category === 'other' ? null : proposal.category, 'note')}-${slugOf(proposal.text.split('\n')[0], proposal.id)}.md`;
  const file = path.join(memoryDir, target);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // No file is overwritten: a suggestion that would collide with an existing note
  // gets its own name instead of silently replacing knowledge.
  let finalTarget = target;
  let counter = 2;
  while (fsSync.existsSync(path.join(memoryDir, finalTarget))) {
    finalTarget = target.replace(/\.md$/u, `-${counter}.md`);
    counter += 1;
  }
  const payload = [
    '---',
    `description: ${(proposal.text.split('\n')[0] || 'Suggestion').slice(0, 120)}`,
    `category: ${proposal.category}`,
    `tags: [suggested]`,
    `createdAt: ${now}`,
    // M3: `modified` — когда знание менялось по существу (свежее mtime двигает любой
    // редактор); `supersedes` — какую заметку эта заменяет.
    `modified: ${now}`,
    proposal.supersedes ? `supersedes: ${proposal.supersedes}` : null,
    proposal.sourceSessionId ? `sourceSessionId: ${proposal.sourceSessionId}` : null,
    proposal.sourceWorkItemId ? `sourceWorkItemId: ${proposal.sourceWorkItemId}` : null,
    proposal.paths.length ? `paths: ${proposal.paths.join(', ')}` : null,
    '---',
    '',
    proposal.text,
    '',
  ].filter(line => line !== null).join('\n');
  await fs.writeFile(path.join(memoryDir, finalTarget), payload, 'utf8');

  const decided = { ...proposal, status: 'accepted', decidedAt: now, target: finalTarget };
  await fs.writeFile(path.join(proposalsDir(memoryDir), proposal.source), renderProposal(decided), 'utf8');
  return { ok: true, proposal: decided, target: finalTarget };
}

/** Rejection keeps the file: what was refused, and why, is part of the record. */
export async function rejectProposal(memoryDir, id, { reason = null, now = new Date().toISOString() } = {}) {
  const proposals = await listProposals(memoryDir);
  const proposal = proposals.find(entry => entry.id === id);
  if (!proposal) return { ok: false, code: 'NOT_FOUND', problems: [{ code: 'NOT_FOUND', message: 'предложение не найдено' }] };
  if (proposal.status !== 'proposed') {
    return { ok: false, code: 'ALREADY_DECIDED', problems: [{ code: 'ALREADY_DECIDED', message: `предложение уже ${proposal.status}` }] };
  }
  const decided = {
    ...proposal,
    status: 'rejected',
    decidedAt: now,
    decisionReason: reason ? String(reason).trim().slice(0, REASON_LIMIT) : null,
  };
  await fs.writeFile(path.join(proposalsDir(memoryDir), proposal.source), renderProposal(decided), 'utf8');
  return { ok: true, proposal: decided };
}

/**
 * Counts for the inspector: how much is waiting for a human, how it went, and — по
 * отказам — какие гейты срабатывают чаще всего. Последнее и есть ответ на «агент
 * слишком часто генерирует мусор именно такого рода».
 */
export function proposalCounts(proposals = []) {
  const reasons = {};
  for (const proposal of proposals) {
    for (const code of proposal.refusals ?? []) reasons[code] = (reasons[code] ?? 0) + 1;
  }
  return {
    pending: proposals.filter(entry => entry.status === 'proposed').length,
    accepted: proposals.filter(entry => entry.status === 'accepted').length,
    rejected: proposals.filter(entry => entry.status === 'rejected').length,
    refused: Object.values(reasons).reduce((sum, count) => sum + count, 0),
    reasons,
  };
}
