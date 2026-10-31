// C03 probe: what would Pi's own compaction policy keep, for a given
// `keepRecentTokens`, on a real session file?
//
// The audit asked whether `keepRecentTokens: 0` already gives a "retain-none"
// compaction in the installed Pi 1.4.0 — before anyone writes a custom
// summarizer. This runs Pi's own `prepareCompaction()` (shipped code, no model
// call, no session written) over real session entries, so the answer is the
// behaviour of the installed version rather than a re-implementation.
//
// Usage:
//   node scripts/pi-compaction-probe.mjs <session.jsonl> [...more]
//   node scripts/pi-compaction-probe.mjs --keep 0,20000 ~/.pi/agent/sessions/**/*.jsonl
//   PI_DIST=<path to pi-coding-agent/dist> node scripts/pi-compaction-probe.mjs …
//
// Measured on 4 real sessions (2026-10-30, Pi 1.4.0):
//   keepRecentTokens 20000 → kept 19 103…20 097 tokens (28-63 entries)
//   keepRecentTokens 0     → kept 1 entry, 0…2 616 tokens
// So 0 does not mean «nothing kept»: Pi always keeps the last cut point (one
// message) and summarizes everything before it. That message is NOT summarized,
// which is why 0 is safe, while an *extension*-provided summary with
// `firstKeptEntryId: null` would drop it unless the summary covers it.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

// Node resolves the package the same way Pi does not: Pi is installed globally, so
// the dist is found through the global root. `APPDATA` / `npm_config_prefix` cover
// the usual Windows installs without spawning npm at all.
function globalRoots() {
  const roots = [];
  if (process.env.PI_DIST) return [];
  if (process.env.npm_config_prefix) roots.push(path.join(process.env.npm_config_prefix, 'node_modules'));
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules', path.join(process.env.HOME || '', 'node_modules'));
  try {
    roots.push(execSync('npm root -g', { encoding: 'utf8' }).trim());
  } catch {
    // No npm on PATH: the fixed candidates above may still be right.
  }
  return roots;
}

function piDistRoot() {
  if (process.env.PI_DIST) return process.env.PI_DIST;
  const packages = [
    path.join('@earendil-works', 'pi-coding-agent'),
    path.join('@mariozechner', 'pi-coding-agent'),
  ];
  for (const root of globalRoots()) {
    for (const name of packages) {
      const candidate = path.join(root, name, 'dist');
      if (fs.existsSync(path.join(candidate, 'core', 'compaction', 'compaction.js'))) return candidate;
    }
  }
  throw new Error('Pi package not found: set PI_DIST to <pi-coding-agent>/dist');
}

const args = process.argv.slice(2);
let keeps = [20000, 0];
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--keep') keeps = String(args[++i] || '').split(',').map(Number).filter(Number.isSafeInteger);
  else files.push(args[i]);
}
if (!files.length) {
  console.error('usage: node scripts/pi-compaction-probe.mjs [--keep 0,20000] <session.jsonl> …');
  process.exit(2);
}

const dist = piDistRoot();
const { prepareCompaction, estimateTokens } = await import(
  new URL(`file://${path.join(dist, 'core', 'compaction', 'compaction.js').replace(/\\/g, '/')}`).href
);
console.log(`# pi dist: ${dist}`);

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const entries = lines.map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(entry => entry && entry.type !== 'session');
  for (const keepRecentTokens of keeps) {
    const preparation = prepareCompaction(entries, { enabled: true, reserveTokens: 16384, keepRecentTokens });
    if (!preparation) {
      console.log(JSON.stringify({ file: path.basename(file), keepRecentTokens, result: 'nothing to compact' }));
      continue;
    }
    const index = entries.findIndex(entry => entry.id === preparation.firstKeptEntryId);
    const kept = index < 0 ? [] : entries.slice(index);
    const keptTokens = kept.reduce((sum, entry) => sum
      + (entry.message ? estimateTokens(entry.message) : 0), 0);
    console.log(JSON.stringify({
      file: path.basename(file),
      keepRecentTokens,
      firstKeptEntryId: preparation.firstKeptEntryId,
      keptEntries: kept.length,
      keptTokens,
      summarizedMessages: preparation.messagesToSummarize.length,
      retainNone: preparation.firstKeptEntryId === entries.at(-1)?.id && kept.length <= 1,
      tokensBefore: preparation.tokensBefore,
    }));
  }
}
