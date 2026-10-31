#!/usr/bin/env node
// C03 live probe: does `compaction.keepRecentTokens: 0` give a zero-tail
// compaction on the installed Pi, and what does the model actually receive
// afterwards?
//
//   node experiments/compact-00/run-zero-tail.mjs [--model deepseek/deepseek-flash] [--keep 0]
//
// Why a separate stand: taskbridge must not change the operator's Pi settings,
// and Pi reads `compaction.*` once at start. So the probe runs its own agent dir
// (PI_CODING_AGENT_DIR), its own cwd and its own session dir, with provider keys
// from the environment only — nothing of the operator's configuration is read or
// written. No extensions are loaded, so the default Pi summarizer runs (the
// operator's own machine also has smart-compaction; that one keeps Pi's cut
// point — see docs/mcp-compact-audit-2026-10-30.md).
//
// Output: printed facts + report.json in .local/compact-00/<stamp>/.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiRpc, sleep } from '../pi-hooks/pi-rpc-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const model = argValue('--model', 'deepseek/deepseek-flash');
const keep = Number(argValue('--keep', '0'));
const pad = Number(argValue('--pad', '0'));
const timeoutMs = Number(argValue('--timeout', '240000'));
const out = path.resolve(argValue('--out', path.join(repo, '.local', 'compact-00', `zero-tail-${Date.now()}`)));

const workspace = path.join(out, 'workspace');
const sessions = path.join(out, 'sessions');
const agentDir = path.join(out, 'pi-agent');
for (const dir of [workspace, sessions, agentDir]) await fs.mkdir(dir, { recursive: true });
await fs.writeFile(path.join(workspace, 'README.md'), '# zero-tail probe\n');
await fs.writeFile(path.join(agentDir, 'settings.json'), `${JSON.stringify({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: keep } }, null, 2)}\n`);

const [provider, modelId] = model.split('/');
const env = { PI_CODING_AGENT_DIR: agentDir, ...(process.env.DEEPSEEK_API_KEY ? { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } : {}) };
const baseArgs = ['--approve', '--session-dir', sessions, '--provider', provider, '--model', modelId];
const report = { at: new Date().toISOString(), model, keepRecentTokens: keep, prompts: [], steps: {} };

async function sessionFile() {
  const files = (await fs.readdir(sessions)).filter(name => name.endsWith('.jsonl')).sort();
  return files.length ? path.join(sessions, files.at(-1)) : null;
}
async function readEntries(file) {
  const text = await fs.readFile(file, 'utf8');
  return text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

// 1. A few exchanges, small on purpose: with keep=0 everything before the last
//    cut point is summarized, so the history only needs to exist, not to be huge.
let rpc = new PiRpc({ cwd: workspace, args: ['--name', 'zero-tail', ...baseArgs], env });
try {
  await rpc.send({ type: 'get_state' }).catch(() => null);
  const prompts = [
    'Ответь одной короткой строкой: какого цвета небо?',
    'Ответь одной короткой строкой: сколько будет 2+2?',
    'Ответь одной короткой строкой: назови столицу Франции.',
    'Ответь одной короткой строкой: назови самый большой океан.',
  ];
  // Filler for the A/B against the default tail: a small history gives
  // `keepRecentTokens: 20000` nothing to summarize (everything stays).
  const filled = pad > 0
    ? prompts.map(message => `${message}\n\n${Array.from({ length: Math.ceil(pad / 200) }, (_, i) => `Строка ${i}: детали конфигурации и результаты проверок перечислены без сокращений.`).join(' ')}\n\nОтветь одной строкой: сколько строк было в тексте выше?`)
    : prompts;
  for (const message of filled) {
    const sent = await rpc.send({ type: 'prompt', message });
    const settled = await rpc.waitFor(record => record.type === 'agent_settled', timeoutMs).then(() => true, () => false);
    report.prompts.push({ message: message.slice(0, 60), chars: message.length, ok: sent.success === true && settled });
  }
  const file = await sessionFile();
  report.sessionFile = file;
  const before = await readEntries(file);
  report.steps.entriesBeforeCompact = before.filter(entry => entry.type !== 'session').length;

  // 2. Manual compaction — the same RPC command TaskBridge sends.
  const compactStart = rpc.events.length;
  const compact = await rpc.send({ type: 'compact' }, timeoutMs).catch(error => ({ success: false, error: error.message }));
  await sleep(1500);
  const endRecord = rpc.events.slice(compactStart).find(record => record.type === 'compaction_end');
  const result = endRecord?.result || compact.data || null;
  report.steps.compact = {
    ok: compact.success === true && Boolean(endRecord),
    error: compact.error || null,
    reason: endRecord?.reason ?? null,
    firstKeptEntryId: result?.firstKeptEntryId ?? null,
    tokensBefore: result?.tokensBefore ?? null,
    estimatedTokensAfter: result?.estimatedTokensAfter ?? null,
    summaryChars: typeof result?.summary === 'string' ? result.summary.length : null,
    usage: result?.usage ?? null,
  };

  // 3. What the file itself says: is the compaction entry its own first-kept
  //    entry (retain-none), and what survives after it?
  const after = await readEntries(file);
  const compactions = after.filter(entry => entry.type === 'compaction');
  const last = compactions.at(-1) || null;
  const keptIndex = last ? after.findIndex(entry => entry.id === last.firstKeptEntryId) : -1;
  report.steps.fileAfterCompact = {
    compactions: compactions.length,
    compactionId: last?.id ?? null,
    firstKeptEntryId: last?.firstKeptEntryId ?? null,
    retainNone: last ? last.firstKeptEntryId === last.id : null,
    keptEntriesAfterBoundary: keptIndex < 0 ? 0 : after.length - keptIndex,
    keptRolesAfterBoundary: keptIndex < 0 ? [] : after.slice(keptIndex).map(entry => entry.message?.role ?? entry.type).slice(0, 8),
    // Pi re-uses the message of the last cut point: it stays, unsummarized.
    systemSnapshotChars: last?.systemMessage ? JSON.stringify(last.systemMessage).length : 0,
    historyIntact: after.length >= before.length,
  };
} finally {
  await rpc.stop().catch(() => {});
}

// 4. Restart on the saved session: the active context must be summary + the one
//    kept message, and a new request must report its real size.
const file = await sessionFile();
if (file) {
  rpc = new PiRpc({ cwd: workspace, args: ['--session', file, '--name', 'zero-tail', ...baseArgs], env });
  try {
    const state = await rpc.send({ type: 'get_state' }).catch(error => ({ success: false, error: error.message }));
    const statsAfterRestart = await rpc.send({ type: 'get_session_stats' }).catch(() => null);
    const sent = await rpc.send({ type: 'prompt', message: 'Ответь одним словом: продолжай.' }).catch(error => ({ success: false, error: error.message }));
    const settled = await rpc.waitFor(record => record.type === 'agent_settled', timeoutMs).then(() => true, () => false);
    const stats = await rpc.send({ type: 'get_session_stats' }).catch(() => null);
    report.steps.afterRestart = {
      restored: state.success === true,
      promptOk: sent.success === true && settled,
      contextUsageOnRestart: statsAfterRestart?.data?.contextUsage ?? null,
      contextUsageAfterPrompt: stats?.data?.contextUsage ?? null,
      totalMessages: stats?.data?.totalMessages ?? null,
    };
  } finally {
    await rpc.stop().catch(() => {});
  }
}

await fs.writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
const key = report.steps.fileAfterCompact || {};
const usage = report.steps.afterRestart?.contextUsageAfterPrompt || {};
console.log(`модель: ${model} | keepRecentTokens: ${keep}`);
console.log(`prompt-ходов: ${report.prompts.filter(item => item.ok).length}/${report.prompts.length}`);
console.log(`compact: ${report.steps.compact?.ok ? 'выполнен' : `НЕ выполнен (${report.steps.compact?.error || 'нет события'})`}`);
console.log(`  tokensBefore: ${report.steps.compact?.tokensBefore ?? null} | оценка после: ${report.steps.compact?.estimatedTokensAfter ?? null} | сводка: ${report.steps.compact?.summaryChars ?? null} симв.`);
console.log(`  firstKeptEntryId = id записи (retain-none): ${key.retainNone}`);
console.log(`  сохранённых записей после границы: ${key.keptEntriesAfterBoundary} (${(key.keptRolesAfterBoundary || []).join(', ')})`);
console.log(`  снимок системного промпта в записи: ${key.systemSnapshotChars} симв.`);
console.log(`  история в файле не урезана: ${key.historyIntact}`);
console.log(`после перезапуска: контекст ${usage.tokens ?? '—'} ток. (${usage.percent ?? '—'}%)`);
console.log(`отчёт: ${path.relative(repo, path.join(out, 'report.json'))}`);
console.log(`рабочий каталог эксперимента: ${path.relative(repo, out)}`);
