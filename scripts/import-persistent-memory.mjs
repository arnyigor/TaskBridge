#!/usr/bin/env node
/**
 * import-persistent-memory.mjs
 *
 * One-time migration: mcpServer `manage_project_memory` slices
 * (data/persistent_memory/<topic>.md, flat, no frontmatter)
 *   -> pi-memory-md layout
 * (<memoryDir>/<project>/notes/<topic>.md, YAML frontmatter)
 *
 * Contract:
 *  - Source files are NEVER modified or deleted (read-only migration).
 *  - Dry-run by default. Writing requires --apply.
 *  - Existing target files are not overwritten unless --force.
 *
 * Usage:
 *   node scripts/import-persistent-memory.mjs --dry-run
 *   node scripts/import-persistent-memory.mjs --apply
 *   node scripts/import-persistent-memory.mjs --apply --out ~/.pi/memory-md --force
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------- args ----------
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

const APPLY = has('--apply');
const FORCE = has('--force');
const SOURCE = path.resolve(
  val('--source', 'G:/AIModels/MCPs/McpServer/data/persistent_memory'),
);
const OUT = path.resolve(val('--out', path.join(os.homedir(), '.pi', 'memory-md')));

// ---------- helpers ----------
const HEADER_RE = /^#\s*Проект:\s*(?<topic>[^|]+)\|\s*Срез от\s*(?<date>\d{4}-\d{2}-\d{2})(?:\s+(?<time>\d{2}:\d{2}))?/u;

function yamlEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
}

/** Topic tags inferred from content keywords (deterministic, no guessing at runtime). */
const KEYWORDS = [
  [/тест|test|pytest|vitest|jest|покрыт/iu, 'testing'],
  [/сборк|build|gradle|npm run|webpack|vite/iu, 'build'],
  [/андроид|android|kotlin|compose/iu, 'android'],
  [/mcp|сервер|server/iu, 'mcp'],
  [/конфиг|config|settings|настройк/iu, 'config'],
  [/модел|model|llm|qwen|llama/iu, 'models'],
  [/git|commit|branch|ветк|rebase/iu, 'git'],
  [/баг|bug|фикс|fix|исправ/iu, 'bugfix'],
  [/деплой|deploy|vercel|cloud|prod/iu, 'deploy'],
];

/**
 * Infer candidate tags from content keywords.
 * Returns candidates + raw match counts so the caller can de-noise them globally.
 */
function inferTags(topic, body) {
  const counts = new Map();
  for (const [re, tag] of KEYWORDS) {
    const hits = (body.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length;
    if (hits > 0) counts.set(tag, hits);
  }
  // 'testing' matches the Russian word "тест" inside unrelated prose very often;
  // require it to actually dominate before it is considered a real signal.
  if (counts.has('testing') && counts.get('testing') < 3) counts.delete('testing');
  return { topic, counts };
}

/**
 * Drop tags that are present in the majority of slices: a tag on almost every
 * file carries no retrieval value and only bloats the injected index.
 */
function filterCommonTags(allCounts, threshold = 0.6) {
  const freq = new Map();
  for (const c of allCounts) {
    for (const tag of c.keys()) freq.set(tag, (freq.get(tag) || 0) + 1);
  }
  const n = allCounts.length || 1;
  return new Set([...freq].filter(([, f]) => f / n <= threshold).map(([t]) => t));
}

/**
 * Parse one legacy slice into { topic, created, updated, description, tags, body }.
 * Robust to a missing "Проект:" header (falls back to filename + mtime).
 */
function parseSlice(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const stat = fs.statSync(file);
  const stem = path.basename(file, '.md');

  const lines = raw.split(/\r?\n/);
  let topic = stem;
  let date = null;
  let time = null;
  let headerLineIdx = -1;

  const m = HEADER_RE.exec(lines[0] ?? '');
  if (m) {
    topic = (m.groups.topic || stem).trim();
    date = m.groups.date;
    time = m.groups.time || null;
    headerLineIdx = 0;
  }

  // First real heading that is not the "Проект:" header line.
  let title = null;
  for (let i = 0; i < lines.length; i++) {
    if (i === headerLineIdx) continue;
    const t = lines[i].trim();
    if (!t) continue;
    if (t.startsWith('#')) title = t.replace(/^#+\s*/, '').trim();
    break;
  }

  const iso = date || new Date(stat.mtimeMs).toISOString().slice(0, 10);
  const updated = date ? (time ? `${date}T${time}` : date) : iso;

  const body = lines
    .filter((_, i) => i !== headerLineIdx)
    .join('\n')
    .replace(/^\s*\n/, '');

  const description = (title || `Memory slice: ${topic}`).slice(0, 120);

  return {
    topic,
    created: iso,
    updated,
    description,
    body,
    tagCandidates: inferTags(topic, body),
  };
}

function frontmatter({ description, tags, created, updated }) {
  return [
    '---',
    `description: "${yamlEscape(description)}"`,
    `tags: [${tags.map((t) => `"${yamlEscape(t)}"`).join(', ')}]`,
    `created: "${created}"`,
    `updated: "${updated}"`,
    '---',
    '',
  ].join('\n');
}

// ---------- main ----------
function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`✖ source directory not found: ${SOURCE}`);
    process.exit(2);
  }

  const files = fs
    .readdirSync(SOURCE)
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .sort();

  if (files.length === 0) {
    console.error(`✖ no .md slices in ${SOURCE}`);
    process.exit(2);
  }

  console.log(`source : ${SOURCE}`);
  console.log(`target : ${OUT}`);
  console.log(`mode   : ${APPLY ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}`);
  console.log(`slices : ${files.length}\n`);

  const plan = [];
  for (const f of files) {
    const s = parseSlice(path.join(SOURCE, f));
    const rel = path.join(s.topic, 'notes', `${path.basename(f)}`);
    plan.push({ src: f, rel, abs: path.join(OUT, rel), slice: s });
  }

  // De-noise tags globally: a tag on almost every slice is not a discriminator.
  const common = filterCommonTags(plan.map((p) => p.slice.tagCandidates.counts));
  for (const p of plan) {
    const kept = [...p.slice.tagCandidates.counts.keys()]
      .filter((t) => common.has(t))
      .sort((a, b) => p.slice.tagCandidates.counts.get(b) - p.slice.tagCandidates.counts.get(a))
      .slice(0, 4);
    p.slice.tags = [p.slice.topic, ...kept].slice(0, 5);
  }

  let conflicts = 0;
  for (const p of plan) {
    const exists = fs.existsSync(p.abs);
    if (exists) conflicts++;
    const mark = exists ? (FORCE ? '~ overwrite' : '✖ exists  ') : '✔ new      ';
    console.log(`${mark} ${p.src.padEnd(34)} -> ${p.rel}`);
    console.log(`              desc="${p.slice.description}"`);
    console.log(`              tags=[${p.slice.tags.join(', ')}]  created=${p.slice.created}\n`);
  }

  if (!APPLY) {
    console.log(`DRY-RUN complete. ${plan.length} slices would be written, ${conflicts} already exist.`);
    if (conflicts && !FORCE) console.log('Re-run with --force to overwrite existing targets.');
    console.log('Nothing was written.');
    return;
  }

  let written = 0;
  let skipped = 0;
  for (const p of plan) {
    if (fs.existsSync(p.abs) && !FORCE) {
      skipped++;
      continue;
    }
    fs.mkdirSync(path.dirname(p.abs), { recursive: true });
    fs.writeFileSync(p.abs, frontmatter(p.slice) + p.slice.body + '\n', 'utf8');
    written++;
  }
  console.log(`APPLY complete. written=${written} skipped=${skipped} (source files untouched)`);
}

main();
