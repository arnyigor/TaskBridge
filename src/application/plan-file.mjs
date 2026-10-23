// One Markdown file is the whole state of a Follow Plan (ТЗ PLAN-FOLLOW-01, FP-01).
//
// The plan's content, steps and statuses live in the file and nowhere else: no
// parallel TODO.md or progress.json, and SQLite keeps only runtime bookkeeping
// (cycle, lease, expected hash). This module owns that file:
//
//   parsePlan / serializePlan  — the managed format, strict and round-trip safe;
//   planHash                   — SHA-256 of the normalised text (CRLF folded, so a
//                                Windows checkout does not look like an edit);
//   readPlan                   — workspace scope, realpath/symlink check, size cap;
//   writePlanAtomic            — temp file + rename with a Windows retry, verified
//                                by reading the bytes back;
//   updatePlan                 — compare-and-swap on revision AND hash, so a human
//                                edit is never overwritten silently (409 upstream);
//   proposeImport              — preview of a free-form plan as managed Markdown.
//                                It never writes: the original text must survive
//                                until the operator accepts the import.
//
// Anything the format does not model is reported as a problem instead of being
// dropped, because a write after a partial parse would silently lose it.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const PLAN_SCHEMA_VERSION = 1;
export const STEP_STATUSES = Object.freeze(['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'SKIPPED']);
export const PRIORITIES = Object.freeze(['P0', 'P1', 'P2', 'P3']);
export const FINDING_STATES = Object.freeze(['OPEN', 'DONE', 'DROPPED']);
export const STEPS_SECTION = 'Шаги';
export const FINDINGS_SECTION = 'Обнаруженные проблемы';
export const DEFAULT_MAX_BYTES = 1024 * 1024;

const STEP_ID = /^S-\d{3,}$/;
const FINDING_ID = /^F-\d{3,}$/;
const PLAN_ID = /^p-[A-Za-z0-9][A-Za-z0-9-]*$/;
const STEP_HEADING = /^###\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*$/;
const FINDING_LINE = /^-\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*$/;
const FIELD = /^\*\*(Критерии|Проверка|Результат|Происхождение):\*\*\s*(.*)$/;

export class PlanError extends Error {
  constructor(code, message, problems = []) {
    super(message);
    this.name = 'PlanError';
    this.code = code;
    this.problems = problems;
  }
}

export const normalizedText = text => String(text ?? '').replace(/\r\n?/g, '\n');
export const planHash = text => crypto.createHash('sha256').update(normalizedText(text), 'utf8').digest('hex');

const blank = line => line.trim() === '';

/** Front matter is a tiny key: value subset — a YAML parser is not needed for it. */
function parseFrontMatter(lines, problems) {
  const values = {};
  for (const line of lines) {
    if (blank(line)) continue;
    const match = /^([a-z_][a-z0-9_]*)\s*:\s*(.*)$/i.exec(line.trim());
    if (!match) { problems.push(`front matter: не понята строка «${line.trim()}»`); continue; }
    const [, key, raw] = match;
    let value = raw.trim();
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { problems.push(`front matter: строка ${key} не разбирается как JSON-строка`); }
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/**
 * Parses the managed plan. Throws `PLAN_INVALID` with a list of problems —
 * including text the format does not model, which would otherwise be lost on
 * the next write.
 */
export function parsePlan(input) {
  const text = normalizedText(input);
  const lines = text.split('\n');
  const problems = [];
  if (lines[0]?.trim() !== '---') {
    throw new PlanError('PLAN_INVALID', 'План должен начинаться с front matter (---).', ['нет front matter']);
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) throw new PlanError('PLAN_INVALID', 'Front matter не закрыт строкой ---.', ['нет закрывающего ---']);
  const front = parseFrontMatter(lines.slice(1, end), problems);

  if (String(front.taskbridge_plan) !== String(PLAN_SCHEMA_VERSION)) {
    problems.push(`taskbridge_plan: ожидается ${PLAN_SCHEMA_VERSION}, получено «${front.taskbridge_plan ?? ''}»`);
  }
  if (!PLAN_ID.test(String(front.plan_id ?? ''))) problems.push('plan_id: ожидается p-<идентификатор>');
  const revision = Number(front.revision);
  if (!Number.isInteger(revision) || revision < 0) problems.push('revision: ожидается целое число >= 0');
  if (!String(front.goal ?? '').trim()) problems.push('goal: цель плана не может быть пустой');

  const plan = {
    schema: PLAN_SCHEMA_VERSION,
    planId: String(front.plan_id ?? ''),
    revision: Number.isInteger(revision) ? revision : 0,
    goal: String(front.goal ?? ''),
    title: '',
    steps: [],
    findings: [],
    extraFront: Object.fromEntries(Object.entries(front).filter(([key]) => !['taskbridge_plan', 'plan_id', 'revision', 'goal'].includes(key)))
  };

  let section = null;
  let step = null;
  for (let index = end + 1; index < lines.length; index++) {
    const line = lines[index];
    if (blank(line)) continue;
    if (line.startsWith('### ')) {
      if (section !== STEPS_SECTION) { problems.push(`шаг вне раздела «${STEPS_SECTION}»: ${line.trim()}`); continue; }
      const match = STEP_HEADING.exec(line.trim());
      if (!match) { problems.push(`заголовок шага не понят: ${line.trim()}`); continue; }
      const [, id, status, priority, title] = match;
      step = { id: id.trim(), status: status.trim(), priority: priority.trim(), title: title.trim(), criteria: '', verification: '', result: '', originFindingId: null };
      plan.steps.push(step);
      continue;
    }
    if (line.startsWith('## ')) {
      section = line.slice(3).trim();
      step = null;
      if (![STEPS_SECTION, FINDINGS_SECTION].includes(section)) problems.push(`неизвестный раздел «${section}»`);
      continue;
    }
    if (line.startsWith('# ') && !plan.title) { plan.title = line.slice(2).trim(); continue; }
    if (section === STEPS_SECTION) {
      if (!step) { problems.push(`текст до первого шага: ${line.trim()}`); continue; }
      const match = FIELD.exec(line.trim());
      if (!match) { problems.push(`шаг ${step.id}: не понята строка «${line.trim()}»`); continue; }
      const [, key, value] = match;
      if (key === 'Критерии') step.criteria = value.trim();
      else if (key === 'Проверка') step.verification = value.trim();
      else if (key === 'Результат') step.result = value.trim();
      else step.originFindingId = value.trim() || null;
      continue;
    }
    if (section === FINDINGS_SECTION) {
      const match = FINDING_LINE.exec(line.trim());
      if (!match) { problems.push(`проблема не понята: ${line.trim()}`); continue; }
      const [, id, priority, state, summary] = match;
      plan.findings.push({ id: id.trim(), priority: priority.trim(), state: state.trim(), summary: summary.trim() });
      continue;
    }
    problems.push(`строка вне разделов (не будет сохранена): ${line.trim()}`);
  }

  problem(plan, problems);
  if (problems.length) throw new PlanError('PLAN_INVALID', `План не соответствует формату: ${problems[0]}`, problems);
  return plan;
}

/** Semantic checks, separate from parsing so callers can report all problems at once. */
function problem(plan, problems) {
  const stepIds = new Set();
  for (const step of plan.steps) {
    if (!STEP_ID.test(step.id)) problems.push(`шаг: ожидается идентификатор S-001, получено «${step.id}»`);
    else if (stepIds.has(step.id)) problems.push(`шаг ${step.id}: идентификатор повторяется`);
    stepIds.add(step.id);
    if (!STEP_STATUSES.includes(step.status)) problems.push(`шаг ${step.id}: неизвестный статус «${step.status}» (допустимо: ${STEP_STATUSES.join(', ')})`);
    if (!PRIORITIES.includes(step.priority)) problems.push(`шаг ${step.id}: неизвестный приоритет «${step.priority}»`);
    if (!step.title) problems.push(`шаг ${step.id}: пустой заголовок`);
    if (!step.criteria) problems.push(`шаг ${step.id}: нет наблюдаемых критериев выполнения`);
    // DONE without evidence is exactly the "test never ran but the box is ticked"
    // case from the ТЗ: the file must say what confirmed it.
    if (step.status === 'DONE' && !step.result) problems.push(`шаг ${step.id}: DONE без результата/доказательства`);
  }
  const findingIds = new Set();
  for (const finding of plan.findings) {
    if (!FINDING_ID.test(finding.id)) problems.push(`проблема: ожидается идентификатор F-001, получено «${finding.id}»`);
    else if (findingIds.has(finding.id)) problems.push(`проблема ${finding.id}: идентификатор повторяется`);
    findingIds.add(finding.id);
    if (!PRIORITIES.includes(finding.priority)) problems.push(`проблема ${finding.id}: неизвестный приоритет «${finding.priority}»`);
    if (!FINDING_STATES.includes(finding.state)) problems.push(`проблема ${finding.id}: неизвестное состояние «${finding.state}»`);
    if (!finding.summary) problems.push(`проблема ${finding.id}: пустое описание`);
  }
  return plan;
}

const quote = value => JSON.stringify(String(value));
const field = (label, value) => (value ? `**${label}:** ${value}` : null);

/** Deterministic: the same plan always produces the same bytes, so the hash means something. */
export function serializePlan(plan) {
  const lines = [
    '---',
    `taskbridge_plan: ${PLAN_SCHEMA_VERSION}`,
    `plan_id: ${plan.planId}`,
    `revision: ${plan.revision}`,
    `goal: ${quote(plan.goal)}`,
    ...Object.entries(plan.extraFront || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}: ${value}`),
    '---',
    '',
    `# ${plan.title || `План: ${plan.goal}`}`,
    '',
    `## ${STEPS_SECTION}`,
    ''
  ];
  for (const step of plan.steps) {
    lines.push(`### ${step.id} | ${step.status} | ${step.priority} | ${step.title}`);
    for (const line of [
      field('Критерии', step.criteria),
      field('Проверка', step.verification),
      field('Результат', step.result),
      field('Происхождение', step.originFindingId)
    ]) if (line) lines.push(line);
    lines.push('');
  }
  lines.push(`## ${FINDINGS_SECTION}`, '');
  for (const finding of plan.findings) lines.push(`- ${finding.id} | ${finding.priority} | ${finding.state} | ${finding.summary}`);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/** Reads one plan inside the workspace. Symlinks and `..` are resolved before the scope check. */
export async function readPlan({ root, relPath, maxBytes = DEFAULT_MAX_BYTES, fsImpl = fs }) {
  if (!root) throw new Error('internal: root required');
  if (!relPath || path.isAbsolute(relPath)) throw new PlanError('PLAN_INVALID', 'Путь плана должен быть относительным путём внутри рабочего каталога.', ['абсолютный или пустой путь']);
  const target = path.resolve(root, relPath);
  if (!inside(root, target)) throw new PlanError('PLAN_INVALID', 'Путь плана выходит за пределы рабочего каталога.', ['path traversal']);
  const realRoot = await fsImpl.realpath(root).catch(() => path.resolve(root));
  let realPath;
  try {
    realPath = await fsImpl.realpath(target);
  } catch (error) {
    if (error.code === 'ENOENT') throw new PlanError('PLAN_NOT_ATTACHED', `Файл плана не найден: ${relPath}`, [relPath]);
    throw error;
  }
  if (!inside(realRoot, realPath)) throw new PlanError('PLAN_INVALID', 'Файл плана указывает за пределы рабочего каталога (symlink).', [realPath]);
  const stat = await fsImpl.stat(realPath);
  if (!stat.isFile()) throw new PlanError('PLAN_INVALID', `План — не обычный файл: ${relPath}`, [relPath]);
  if (stat.size > maxBytes) throw new PlanError('PLAN_INVALID', `Файл плана больше ${maxBytes} байт.`, [`${stat.size} bytes`]);
  const text = normalizedText(await fsImpl.readFile(realPath, 'utf8'));
  const plan = parsePlan(text);
  return { relPath, realPath, text, hash: planHash(text), plan };
}

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'EAGAIN']);

/**
 * Temp file + rename in the same directory. On Windows a rename over a file an
 * editor has open fails with EPERM/EBUSY for a short while, hence the retry;
 * the written bytes are read back so a "successful" rename is not taken on trust.
 */
export async function writePlanAtomic({ file, text, expectedHash = null, fsImpl = fs, attempts = 5, delayMs = 40, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const payload = normalizedText(text);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsImpl.writeFile(tmp, payload, 'utf8');
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (expectedHash && planHash(await fsImpl.readFile(file, 'utf8')) !== expectedHash) {
        throw new PlanError('PLAN_REVISION_CONFLICT', 'Файл изменился перед заменой: внешняя версия сохранена.');
      }
      await fsImpl.rename(tmp, file);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE.has(error.code)) break;
      await sleep(delayMs);
    }
  }
  if (lastError) {
    await fsImpl.rm(tmp, { force: true }).catch(() => {});
    if (lastError.code === 'PLAN_REVISION_CONFLICT') throw lastError;
    throw new PlanError('PLAN_WRITE_FAILED', `Не удалось заменить файл плана: ${lastError.code || lastError.message}`, [String(lastError.code || lastError.message)]);
  }
  const written = normalizedText(await fsImpl.readFile(file, 'utf8'));
  if (planHash(written) !== planHash(payload)) {
    throw new PlanError('PLAN_WRITE_FAILED', 'Записанный файл плана не совпадает с подготовленным содержимым.', ['hash mismatch']);
  }
  return { hash: planHash(written) };
}

const nextId = (items, prefix) => {
  const max = items.reduce((best, item) => {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(item.id);
    return match ? Math.max(best, Number(match[1])) : best;
  }, 0);
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
};
export const nextStepId = plan => nextId(plan.steps, 'S');
export const nextFindingId = plan => nextId(plan.findings, 'F');

const requireStep = (plan, stepId) => {
  const step = plan.steps.find(item => item.id === stepId);
  if (!step) throw new PlanError('PLAN_INVALID', `Шага ${stepId} нет в плане.`, [stepId]);
  return step;
};

/**
 * The only supported edits. Everything else has to go through the file itself,
 * so the format cannot drift into two dialects.
 */
export function applyChanges(plan, changes) {
  const { ops = [] } = changes || {};
  for (const op of ops) {
    switch (op.op) {
      case 'set_step_status': {
        const step = requireStep(plan, op.stepId);
        if (!STEP_STATUSES.includes(op.status)) throw new PlanError('PLAN_INVALID', `Неизвестный статус «${op.status}».`, [op.status]);
        if (op.status === 'SKIPPED' && !op.reason) throw new PlanError('PLAN_INVALID', 'SKIPPED требует причины.', [op.stepId]);
        if (op.status === 'DONE' && !(op.result || step.result)) throw new PlanError('PLAN_INVALID', `Шаг ${op.stepId}: DONE требует результата.`, [op.stepId]);
        step.status = op.status;
        if (op.result) step.result = op.result;
        break;
      }
      case 'set_step_result': requireStep(plan, op.stepId).result = op.result || ''; break;
      case 'add_step': {
        if (plan.steps.some(step => step.id === op.stepId)) throw new PlanError('PLAN_INVALID', `Шаг ${op.stepId} уже есть.`, [op.stepId]);
        if (!STEP_ID.test(op.stepId)) throw new PlanError('PLAN_INVALID', `Неверный идентификатор шага «${op.stepId}».`, [op.stepId]);
        if (!PRIORITIES.includes(op.priority)) throw new PlanError('PLAN_INVALID', `Неверный приоритет «${op.priority}».`, [op.priority]);
        if (!op.criteria || !op.verification) throw new PlanError('PLAN_INVALID', 'Новый шаг требует критериев и способа проверки.', [op.stepId]);
        const step = {
          id: op.stepId,
          status: 'TODO',
          priority: op.priority,
          title: op.title || '',
          criteria: op.criteria,
          verification: op.verification,
          result: '',
          originFindingId: op.originFindingId || null
        };
        // Insertion point is explicit in the file, so execution order needs no
        // hidden rule: `before` puts a blocking defect ahead of the step it blocks.
        const before = op.before ? plan.steps.findIndex(item => item.id === op.before) : -1;
        const after = op.after ? plan.steps.findIndex(item => item.id === op.after) : -1;
        if (before >= 0) plan.steps.splice(before, 0, step);
        else if (after >= 0) plan.steps.splice(after + 1, 0, step);
        else plan.steps.push(step);
        break;
      }
      case 'add_finding': {
        if (plan.findings.some(finding => finding.id === op.findingId)) throw new PlanError('PLAN_INVALID', `Проблема ${op.findingId} уже есть.`, [op.findingId]);
        if (!FINDING_ID.test(op.findingId)) throw new PlanError('PLAN_INVALID', `Неверный идентификатор проблемы «${op.findingId}».`, [op.findingId]);
        if (!PRIORITIES.includes(op.priority)) throw new PlanError('PLAN_INVALID', `Неверный приоритет «${op.priority}».`, [op.priority]);
        plan.findings.push({ id: op.findingId, priority: op.priority, state: 'OPEN', summary: op.summary || '' });
        break;
      }
      case 'set_finding_state': {
        const finding = plan.findings.find(item => item.id === op.findingId);
        if (!finding) throw new PlanError('PLAN_INVALID', `Проблемы ${op.findingId} нет в плане.`, [op.findingId]);
        if (!FINDING_STATES.includes(op.state)) throw new PlanError('PLAN_INVALID', `Неизвестное состояние «${op.state}».`, [op.state]);
        finding.state = op.state;
        break;
      }
      default: throw new PlanError('PLAN_INVALID', `Неизвестная операция «${op.op}».`, [String(op.op)]);
    }
  }
  return plan;
}

/**
 * Compare-and-swap write. A human edit (different hash) or a stale revision is a
 * conflict, not something to overwrite: the file belongs to the operator too.
 */
const planWrites = new Map();

/** Serialize CAS read/modify/write for one file within this server process. */
export async function withPlanWriteLock(file, action) {
  const absolute = path.resolve(file);
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  const previous = planWrites.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  planWrites.set(key, current);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (planWrites.get(key) === current) planWrites.delete(key);
  }
}

export async function updatePlan(input) {
  return withPlanWriteLock(path.resolve(input.root, input.relPath), () => updatePlanLocked(input));
}

async function updatePlanLocked({ root, relPath, expectedRevision, expectedHash, changes, fsImpl = fs, maxBytes, sleep }) {
  const current = await readPlan({ root, relPath, fsImpl, maxBytes });
  if (expectedHash && current.hash !== expectedHash) {
    throw new PlanError('PLAN_REVISION_CONFLICT', 'Файл плана изменён снаружи: хэш не совпадает с ожидаемым.', [`expected ${expectedHash}`, `actual ${current.hash}`]);
  }
  if (expectedRevision != null && current.plan.revision !== expectedRevision) {
    throw new PlanError('PLAN_REVISION_CONFLICT', `Ревизия плана ${current.plan.revision}, ожидалась ${expectedRevision}.`, [String(current.plan.revision)]);
  }
  const next = applyChanges(structuredClone(current.plan), changes);
  next.revision = current.plan.revision + 1;
  const text = serializePlan(next);
  const { hash } = await writePlanAtomic({ file: current.realPath, text, expectedHash: current.hash, fsImpl, sleep });
  return { plan: next, text, hash, realPath: current.realPath };
}

/** Import is a preview: the returned text is for review, the source file is untouched. */
export function proposeImport(input, { planId = 'p-imported', goal = '' } = {}) {
  const lines = normalizedText(input).split('\n');
  const problems = [];
  const unmapped = [];
  const steps = [];
  let title = '';
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('# ')) { title = trimmed.slice(2).trim(); continue; }
    if (trimmed.startsWith('## ')) { current = null; continue; }
    const checkbox = /^[-*]\s*\[( |x|X)]\s*(.+)$/.exec(trimmed);
    if (checkbox) {
      // A ticked box in the imported file is the operator's claim, not evidence:
      // the step starts as TODO and the note says why.
      if (checkbox[1].toLowerCase() === 'x') unmapped.push(`отмечено выполненным в источнике, подтверждения нет: ${checkbox[2].trim()}`);
      current = {
        id: `S-${String(steps.length + 1).padStart(3, '0')}`,
        status: 'TODO',
        priority: 'P1',
        title: checkbox[2].trim(),
        criteria: 'импортировано: критерий не задан, уточнить при приёмке',
        verification: 'импортировано: способ проверки не задан',
        // Nothing confirmed the imported checkbox, so it cannot claim a result.
        result: '',
        originFindingId: null
      };
      steps.push(current);
      continue;
    }
    if (trimmed.startsWith('### ')) {
      current = {
        id: `S-${String(steps.length + 1).padStart(3, '0')}`,
        status: 'TODO',
        priority: 'P1',
        title: trimmed.slice(4).trim(),
        criteria: 'импортировано: критерий не задан, уточнить при приёмке',
        verification: 'импортировано: способ проверки не задан',
        result: '',
        originFindingId: null
      };
      steps.push(current);
      continue;
    }
    if (current) {
      current.criteria = current.criteria.startsWith('импортировано') ? trimmed : `${current.criteria} ${trimmed}`;
      continue;
    }
    unmapped.push(trimmed);
  }
  if (!steps.length) problems.push('в файле не найдено ни одного шага (список - [ ] или заголовки ###)');
  const plan = { schema: PLAN_SCHEMA_VERSION, planId, revision: 0, goal: goal || title || 'Импортированный план', title, steps, findings: [], extraFront: {} };
  problem(plan, problems);
  return { plan, content: steps.length ? serializePlan(plan) : null, problems, unmapped };
}
