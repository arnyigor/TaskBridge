#!/usr/bin/env node
/**
 * verify-memory-layout.mjs
 *
 * Reproduces pi-memory-md's OWN delivery logic to answer one question:
 * "will the memory of this project actually be injected into the session?"
 *
 * It mirrors the real code paths (pi-memory-md@0.1.38):
 *   index.ts:209-218   getMemoryDir(settings, ctx.cwd)
 *                      gate: fs.existsSync(getMemoryCoreDir(memoryDir))  -> else NO delivery
 *   memory-core.ts:584 scanDir = getMemoryCoreDir(projectMemoryDir)
 *   memory-core.ts:555 readMemoryFiles(scanDir) -> listMemoryFilesAsync (recursive walkDir)
 *   memory-core.ts:386 files = *.md
 *
 * A wrong folder (e.g. root-level notes/) exists on disk and is still reachable
 * via tools, but is NOT auto-delivered — this script makes that visible.
 *
 * Usage:
 *   node scripts/verify-memory-layout.mjs --memory-root <dir> --project <repo-dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const argv = process.argv.slice(2);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

const MEMORY_ROOT = path.resolve(val('--memory-root', path.join(process.env.USERPROFILE || process.env.HOME, '.pi', 'memory-md')));
const PROJECT = path.resolve(val('--project', process.cwd()));

// --- mirror of getProjectMeta(): name = basename(git rev-parse --show-toplevel) ---
function gitToplevel(cwd) {
  try {
    return execSync('git rev-parse --show-toplevel', { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

const toplevel = gitToplevel(PROJECT);
const projectName = path.basename(toplevel || PROJECT);
const memoryDir = path.join(MEMORY_ROOT, projectName);
const coreDir = path.join(memoryDir, 'core'); // getMemoryCoreDir()

// --- mirror of listMemoryFilesAsync(): recursive walk for *.md ---
function listMemoryFiles(dir) {
  const out = [];
  (function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
    }
  })(dir);
  return out.sort();
}

// --- minimal frontmatter parse (gray-matter equivalent for our fields) ---
function readFrontmatter(file) {
  const txt = fs.readFileSync(file, 'utf8');
  if (!txt.startsWith('---')) return { data: {}, ok: false };
  const end = txt.indexOf('\n---', 3);
  if (end === -1) return { data: {}, ok: false };
  const fm = txt.slice(4, end);
  const data = {};
  for (const line of fm.split(/\r?\n/)) {
    const m = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    let v = m[2].trim().replace(/^"(.*)"$/, '$1');
    data[m[1]] = v;
  }
  return { data, ok: Boolean(data.description) };
}

// ================= report =================
console.log(`project repo : ${toplevel || '(not a git repo) ' + PROJECT}`);
console.log(`project name : ${projectName}`);
console.log(`memory dir   : ${memoryDir}`);
console.log(`scan dir     : ${coreDir}   <- scanDir = getMemoryCoreDir()`);
console.log();

const gateOpen = fs.existsSync(coreDir);
console.log(`GATE (existsSync("${path.basename(memoryDir)}/core")): ${gateOpen ? 'PASS' : 'FAIL'}`);
if (!gateOpen) {
  console.log('  -> initDeliveryContent() returns false: memory will NOT be injected');
  console.log('     (files may still exist elsewhere and be reachable via tools only)');
}
console.log();

const files = listMemoryFiles(gateOpen ? coreDir : coreDir);
console.log(`files in scan dir: ${files.length}`);
let bad = 0;
for (const f of files) {
  const { data, ok } = readFrontmatter(f);
  if (!ok) bad++;
  console.log(`  ${ok ? 'OK ' : 'BAD'} ${path.relative(memoryDir, f)}`);
  console.log(`      description: ${data.description || '(missing!)'}`);
  console.log(`      tags: ${data.tags || '(none)'}`);
}
console.log();

// what a root-level notes/ dir would look like (the earlier mistake)
const stray = path.join(memoryDir, 'notes');
if (fs.existsSync(stray)) {
  const n = listMemoryFiles(stray).length;
  console.log(`WARN  stray root-level notes/ exists with ${n} file(s) - NOT auto-delivered.`);
  console.log('      move them to core/project/');
  console.log();
}

// --- token estimate of the injected index ---
let idx = 0;
for (const f of files) {
  const { data } = readFrontmatter(f);
  idx += path.relative(memoryDir, f).length + (data.description || '').length + (data.tags || '').length;
}
console.log(`index payload: ~${idx} chars (~${Math.round(idx / 3.3)} tokens) - this is what gets injected each session`);
console.log(`full text    : ~${files.reduce((a, f) => a + fs.statSync(f).size, 0)} chars (read on demand)`);
console.log();

const verdict = gateOpen && files.length > 0 && bad === 0;
console.log(verdict ? 'VERDICT: OK - memory will be injected' : 'VERDICT: BROKEN - memory will NOT be injected');
process.exit(verdict ? 0 : 1);
