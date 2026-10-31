#!/usr/bin/env node
// Low vs medium thinking on a realistic Android/KMP task, on the local model.
//
//   node experiments/thinking-level/run-compare.mjs --thinking low
//   node experiments/thinking-level/run-compare.mjs --thinking medium
//
// The task (bug + feature + refactor) is planted by fixture.mjs on a copy of the
// real `clients/kmp/core` module; the verdict is the project's own Gradle tests,
// not an opinion. Everything is measured from the run: wall time, tokens, how much
// of the assistant text is thinking, tool calls, whether the acceptance file was
// touched.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PiRpc } from '../pi-hooks/pi-rpc-client.mjs';
import { TEST_RELATIVE, prepareFixture } from './fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const thinking = argValue('--thinking', 'low');
const provider = argValue('--provider', 'llama.cpp');
const modelId = argValue('--model', 'qwen-27b-q3');
const capMs = Number(argValue('--cap-ms', '900000'));
const out = path.resolve(argValue('--out', path.join(repo, '.local', 'thinking-level', `${thinking}-${Date.now()}`)));

const sessions = path.join(out, 'sessions');
await fs.mkdir(sessions, { recursive: true });
// No isolated agent dir: the llama.cpp provider lives in the operator's
// models.json *and* needs credentials from auth.json, so a copied agent dir cannot
// start it. Nothing of the operator's config is modified — the thinking level is a
// per-launch flag, and `-ne` keeps extensions/MCP out of both runs so they carry the
// same tool set.
const fixture = await prepareFixture(out);
const work = fixture.work;
const started = Date.now();
const rpc = new PiRpc({
  cwd: work,
  args: [
    '-ne', '--approve', '--session-dir', sessions, '--provider', provider, '--model', modelId,
    '--thinking', thinking, '--name', `android-${thinking}`,
  ],
  env: {},
});

// Gradle in a copied tree must not reuse the parent's configuration cache.
async function gradle(args) {
  return new Promise(resolve => {
    const child = spawn(path.join(work, 'gradlew'), ['-p', 'core', ':client:jvmTest', '--no-configuration-cache', '--console=plain', ...args], {
      cwd: work, shell: process.platform === 'win32', env: { ...process.env, ...{} },
    });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.on('close', code => resolve({ code, output }));
    setTimeout(() => child.kill(), 600_000);
  });
}


// Failed test names from Gradle's own JUnit XML: the verdict has to survive tests
// that are red in the sandbox for environmental reasons (a copied tree is not the
// operator's machine), so what matters is «no new failures» + «acceptance green».
// Split on the tag rather than a regex: attribute order differs between Gradle
// versions, and a regex that bakes in one order silently reports zero failures.
async function failedTests(work) {
  const dir = path.join(work, 'core/client/build/test-results/jvmTest');
  const names = new Set();
  let files = [];
  try { files = (await fs.readdir(dir)).filter(name => name.endsWith('.xml')); } catch { return names; }
  for (const file of files) {
    const xml = await fs.readFile(path.join(dir, file), 'utf8');
    for (const chunk of xml.split('<testcase').slice(1)) {
      const head = chunk.slice(0, chunk.indexOf('>') + 1);
      const body = chunk.slice(chunk.indexOf('>') + 1).split('</testcase>')[0];
      const className = (head.match(/classname="([^"]*)"/) || [])[1] || '';
      const name = (head.match(/name="([^"]*)"/) || [])[1] || '';
      if (body.includes('<failure') || body.includes('<error')) names.add(`${className}.${name}`);
    }
  }
  return names;
}

const report = { at: new Date().toISOString(), thinking, provider, model: modelId, capMs };
try {
  // `--rerun-tasks` on the baseline: a copied tree may report UP-TO-DATE from a
  // previous build and leave no fresh JUnit XML, which would make «no new failures»
  // meaningless.
  const before = await gradle(['--rerun-tasks']);
  report.baselineFailures = [...await failedTests(work)].sort();
  report.baselineTestsPass = report.baselineFailures.length === 0;
  report.baseline = before.output.split('\n').filter(line => /FAILED|BUILD/.test(line)).slice(-6);

  await rpc.send({ type: 'get_state' }).catch(() => null);
  await rpc.send({ type: 'prompt', message: 'Открой TASK.md и выполни задание целиком. Проверяй себя командой из раздела «Проверка».' }).catch(() => null);
  // Wait for the agent to settle, but never longer than the cap.
  const settle = await Promise.race([
    rpc.waitFor(record => record.type === 'agent_settled', capMs).then(() => 'settled', () => 'timeout'),
    new Promise(resolve => setTimeout(() => resolve('cap'), capMs)),
  ]).catch(() => 'error');
  report.settleType = settle;
  report.wallMs = Date.now() - started;

  const stats = await rpc.send({ type: 'get_session_stats' }).catch(() => null);
  report.tokens = stats?.data?.tokens ?? null;
  report.totalMessages = stats?.data?.totalMessages ?? null;

  const after = await gradle([]);
  const failures = [...await failedTests(work)].sort();
  report.failuresAfter = failures;
  report.newFailures = failures.filter(name => !report.baselineFailures.includes(name));
  report.testsPass = after.code === 0;
  report.acceptanceGreen = failures.filter(name => name.includes('SessionQueryAcceptanceTest')).length === 0;
  report.testSummary = after.output.split('\n').filter(line => /FAILED|BUILD/.test(line)).slice(-8);
} finally {
  await rpc.stop().catch(() => {});
}

// What the run actually produced: thinking vs text, tool calls, tests untouched.
const files = (await fs.readdir(sessions)).filter(name => name.endsWith('.jsonl'));
if (files.length) {
  const text = await fs.readFile(path.join(sessions, files[0]), 'utf8');
  const entries = text.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  let thinkingChars = 0, textChars = 0, toolCalls = 0, toolResults = 0;
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message.role === 'toolResult') { toolResults += 1; continue; }
    if (message.role !== 'assistant') continue;
    for (const part of message.content || []) {
      if (part.type === 'thinking') thinkingChars += part.thinking.length;
      else if (part.type === 'text') textChars += part.text.length;
      else if (part.type === 'toolCall') toolCalls += 1;
    }
  }
  report.thinkingChars = thinkingChars;
  report.textChars = textChars;
  report.toolCalls = toolCalls;
  report.toolResults = toolResults;
  // Any edit of the acceptance file is a failed run, whatever the tests say.
  const acceptancePath = path.join(work, TEST_RELATIVE);
  report.acceptanceIntact = (await fs.readFile(acceptancePath, 'utf8').catch(() => '')) === fixture.testSource;
  // The planted bug must be gone.
  const sessionList = await fs.readFile(path.join(work, 'core/client/src/commonMain/kotlin/ru/arny/taskbridge/core/client/sessions/SessionList.kt'), 'utf8');
  report.bugStillPresent = sessionList.includes(fixture.buggy);
  report.queryClassAdded = (await fs.readdir(path.join(work, 'core/client/src/commonMain/kotlin/ru/arny/taskbridge/core/client/sessions'))).some(name => /Query/i.test(name));
}

await fs.writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`thinking=${thinking} модель=${provider}/${modelId}`);
console.log(`база до работы: красных ${report.baselineFailures?.length ?? '?'} (сюда входят приёмочные и «средовые»)`);
console.log(`итог: ${report.settleType}, ${Math.round((report.wallMs || 0) / 1000)} с`);
console.log(`приёмочные: ${report.acceptanceGreen ? 'ЗЕЛЁНЫЕ' : 'красные'} | новых падений: ${report.newFailures?.length ?? '?'} ${JSON.stringify(report.newFailures?.slice(0, 4) ?? [])}`);
console.log(`баг остался: ${report.bugStillPresent} | вынесен query-класс: ${report.queryClassAdded} | приёмочный файл цел: ${report.acceptanceIntact}`);
console.log(`токены: ${JSON.stringify(report.tokens)} | сообщений: ${report.totalMessages}`);
console.log(`ассистент: thinking ${report.thinkingChars ?? '—'} симв., текст ${report.textChars ?? '—'} симв.; вызовов ${report.toolCalls ?? '—'}, результатов ${report.toolResults ?? '—'}`);
console.log(`отчёт: ${path.relative(repo, path.join(out, 'report.json'))}`);
