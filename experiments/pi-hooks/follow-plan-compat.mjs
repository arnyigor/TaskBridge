#!/usr/bin/env node
// FP-00 стенд: подтверждение поверхности Pi 1.4.0, на которой стоит Follow Plan.
//
//   node experiments/pi-hooks/follow-plan-compat.mjs --model deepseek/deepseek-flash
//
// Что проверяется на настоящем Pi (свой agent-dir, свой workspace, свои сессии —
// каталог оператора и запущенный TaskBridge не читаются и не меняются):
//   A. extension-tool `taskbridge_plan_checkpoint` регистрируется и вызывается
//      моделью; аргументы приходят в RPC-кадре `tool_execution_start` целиком,
//      то есть контроллер может принять checkpoint без второго канала.
//   B. отсутствие checkpoint: `agent_before_settle` + `continue:true` дают ровно
//      один дополнительный запрос к модели и ровно один `agent_settled`.
//   C. STOP: `abort` гасит ход, `agent_settled.aborted === true`, isStreaming
//      false, сессия после этого принимает новый prompt.
//   D. очередь: `follow_up` во время хода — это второй turn в том же ранe,
//      `agent_end` приходит ДО финального `agent_settled`.
//
// Отчёт: <out>/report.json, журналы хуков: <out>/hook-*.jsonl.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PiRpc, sleep } from './pi-rpc-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};

const model = argValue('--model', 'deepseek/deepseek-flash');
const timeoutMs = Number(argValue('--timeout', '180000'));
const out = path.resolve(argValue('--out', path.join(repo, '.local', 'fp-00', `compat-${Date.now()}`)));
const fixture = path.join(here, 'follow-plan-checkpoint-fixture.js');
// Any extension can be checked with the same stand: the production checkpoint
// tool (pi-extension/taskbridge-follow-plan.js) is the interesting second case.
const extension = path.resolve(argValue('--extension', fixture));
const isFixture = extension === fixture;

await fs.mkdir(out, { recursive: true });
const workspace = path.join(out, 'workspace');
const sessions = path.join(out, 'sessions');
const agentDir = path.join(out, 'pi-agent');
await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
for (const dir of [workspace, sessions, agentDir]) await fs.mkdir(dir, { recursive: true });
await fs.mkdir(path.join(workspace, 'docs'), { recursive: true });
await fs.writeFile(path.join(workspace, 'docs', 'PLAN.md'), [
  '---',
  'taskbridge_plan: 1',
  'plan_id: p-fp00',
  'revision: 1',
  'goal: "FP-00: проверить поверхность Pi 1.4.0"',
  '---',
  '',
  '## Шаги',
  '',
  '### S-001 | TODO | P1 | Создать progress.txt',
  '**Критерии:** файл содержит done.',
  '',
  '### S-002 | TODO | P1 | Сообщить checkpoint',
  '**Критерии:** checkpoint получен контроллером.'
].join('\n'));

const piVersion = await new Promise(resolve => {
  const child = spawn('pi', ['--version'], { windowsHide: true, shell: process.platform === 'win32' });
  let text = '';
  child.stdout.on('data', chunk => { text += chunk; });
  child.on('exit', () => resolve(text.trim()));
});

const modelArgs = ['--provider', model.split('/')[0], '--model', model.split('/')[1]];
const baseEnv = { PI_CODING_AGENT_DIR: agentDir };
const results = {};
const mark = (name, ok, detail = null) => { results[name] = { ok, detail }; };

/** Новый процесс Pi на изолированной сессии. */
function start({ name, log, env = {} }) {
  return new PiRpc({
    cwd: workspace,
    args: ['--approve', '--session-dir', sessions, '--name', name, '-e', extension, ...modelArgs],
    env: { ...baseEnv, FP_LOG: path.join(out, `hook-${log}.jsonl`), ...env }
  });
}

const windowFrames = (rpc, from) => rpc.events.slice(from);
const count = (frames, type) => frames.filter(frame => frame.type === type).length;

/** Ждёт, пока предикат по накопленным кадрам станет истинным (опрос вместо гонки). */
async function waitUntil(rpc, from, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(rpc.events.slice(from))) return true;
    await sleep(250);
  }
  return false;
}
const toolFrames = (frames, name) => frames.filter(frame => String(frame.type).startsWith('tool_execution_') && String(frame.toolName || '').includes(name));
const readLog = async file => (await fs.readFile(path.join(out, file), 'utf8').catch(() => ''))
  .split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);

// --- A + D: checkpoint и очередь ---------------------------------------------
{
  const rpc = start({ name: 'fp-a', log: 'a' });
  await rpc.send({ type: 'get_state' }).catch(() => null);
  const fromA = rpc.events.length;
  const prompt = await rpc.send({
    type: 'prompt',
    message: 'Режим FOLLOW PLAN. Шаг S-001: создай в рабочем каталоге файл progress.txt с содержимым done. '
      + 'После этого ОБЯЗАТЕЛЬНО вызови инструмент taskbridge_plan_checkpoint с аргументами '
      + '{"planId":"p-fp00","revision":1,"cycleId":"c-1","decision":"CONTINUE","completedStepIds":["S-001"],"nextStepId":"S-002"}. '
      + 'Ответ — одна короткая строка.'
  });
  const settledA = await rpc.waitFor(record => record.type === 'agent_settled', timeoutMs).then(() => true, () => false);
  const framesA = windowFrames(rpc, fromA);
  const starts = toolFrames(framesA, 'taskbridge_plan_checkpoint').filter(frame => frame.type === 'tool_execution_start');
  const ends = toolFrames(framesA, 'taskbridge_plan_checkpoint').filter(frame => frame.type === 'tool_execution_end');
  const args = starts[0]?.args || {};
  const logA = await readLog('hook-a.jsonl');

  mark('A.extension_tool_callable', starts.length >= 1 && (ends[0]?.isError ?? true) !== true, {
    promptAccepted: prompt.success === true,
    settled: settledA,
    calls: starts.length,
    isError: ends[0]?.isError ?? null,
    durationMs: ends[0]?.durationMs ?? null
  });
  mark('A.checkpoint_args_over_rpc', args.planId === 'p-fp00' && Number(args.revision) === 1
    && args.cycleId === 'c-1' && args.decision === 'CONTINUE' && Array.isArray(args.completedStepIds), {
    args, toolCallId: starts[0]?.toolCallId ?? null
  });
  mark('A.turn_boundary_visible', framesA.some(frame => frame.type === 'turn_end') && framesA.some(frame => frame.type === 'agent_settled'), {
    turnEnd: count(framesA, 'turn_end'),
    agentEnd: count(framesA, 'agent_end'),
    settled: count(framesA, 'agent_settled'),
    settledAborted: framesA.find(frame => frame.type === 'agent_settled')?.aborted ?? null
  });
  // The hook journal belongs to the fixture; another extension has no reason to
  // write it, so this check is not a verdict about that extension.
  if (!isFixture) {
    results['A.hooks_reached'] = { ok: true, skipped: 'hook journal is written by the fixture extension only' };
  } else mark('A.hooks_reached', logA.some(entry => entry.hook === 'tool_execute' && entry.decision === 'CONTINUE')
    && logA.some(entry => entry.hook === 'agent_before_settle' && entry.outcome === 'completed'), {
    toolExecute: logA.filter(entry => entry.hook === 'tool_execute').length,
    beforeSettle: logA.filter(entry => entry.hook === 'agent_before_settle').length,
    settled: logA.filter(entry => entry.hook === 'agent_settled').length,
    beforeSettleOutcome: logA.find(entry => entry.hook === 'agent_before_settle')?.outcome ?? null,
    llmMessages: logA.find(entry => entry.hook === 'agent_before_settle')?.llmMessages ?? null
  });

  // D: очередь. follow_up во время хода. Ход может быть коротким, поэтому
  // follow_up может попасть в ещё идущий ран (второй turn) или в уже idle
  // сессию (новый ран) — оба варианта проверяются, важен сам факт доставки и
  // то, что agent_end не финален.
  const fromD = rpc.events.length;
  await rpc.send({ type: 'prompt', message: 'Назови по одному слову три первых цвета радуги, каждый с новой строки, без пояснений.' });
  await sleep(800);
  const followUp = await rpc.send({ type: 'follow_up', message: 'После ответа добавь отдельной строкой слово QUEUED.' })
    .catch(error => ({ success: false, error: error.message }));
  const delivered = await waitUntil(rpc, fromD, frames => count(frames, 'agent_settled') >= 2
    || (count(frames, 'agent_settled') >= 1 && count(frames, 'turn_start') >= 2), timeoutMs);
  const framesD = windowFrames(rpc, fromD);
  const turnStartsD = count(framesD, 'turn_start');
  const settleD = count(framesD, 'agent_settled');
  const lastAgentEnd = framesD.map(frame => frame.type).lastIndexOf('agent_end');
  const firstSettle = framesD.findIndex(frame => frame.type === 'agent_settled');
  mark('D.queue_after_agent_end', followUp.success === true && delivered && turnStartsD >= 2, {
    disposition: followUp.data?.disposition ?? null,
    turnStarts: turnStartsD,
    agentEnds: count(framesD, 'agent_end'),
    settles: settleD,
    // agent_end приходит до финального agent_settled: следующее действие нельзя
    // ставить по agent_end, только по settled.
    agentEndBeforeSettle: lastAgentEnd >= 0 && firstSettle > lastAgentEnd,
    queueUpdates: count(framesD, 'queue_update')
  });
  await rpc.stop();
}

// --- B: один контрольный ход вместо бесконечной цепочки ----------------------
if (!isFixture) {
  results['B.single_audit_turn'] = { ok: true, skipped: 'the extension under test does not request continuations' };
} else {
  const rpc = start({ name: 'fp-b', log: 'b', env: { FP_ALLOW_CONTINUE: '1' } });
  await rpc.send({ type: 'get_state' }).catch(() => null);
  const fromB = rpc.events.length;
  await rpc.send({ type: 'prompt', message: 'Ответь одним словом: готово' });
  const settledB = await rpc.waitFor(record => record.type === 'agent_settled', timeoutMs).then(() => true, () => false);
  const framesB = windowFrames(rpc, fromB);
  const logB = await readLog('hook-b.jsonl');
  const settleHooks = logB.filter(entry => entry.hook === 'agent_before_settle');
  // Ход без checkpoint: хук продолжает один раз, контроллер получает вторую
  // попытку, но settle остаётся ровно один (петли нет).
  mark('B.single_audit_turn', settledB && count(framesB, 'agent_settled') === 1
    && settleHooks.length === 2 && count(framesB, 'turn_start') >= 2, {
    turnStarts: count(framesB, 'turn_start'),
    settled: count(framesB, 'agent_settled'),
    beforeSettleHooks: settleHooks.length,
    continueProposed: settleHooks.map(entry => entry.continueProposed),
    checkpointsFromAudit: logB.filter(entry => entry.hook === 'tool_execute').length
  });
  await rpc.stop();
}

// --- C: STOP ----------------------------------------------------------------
{
  const rpc = start({ name: 'fp-c', log: 'c' });
  await rpc.send({ type: 'get_state' }).catch(() => null);
  const fromC = rpc.events.length;
  await rpc.send({ type: 'prompt', message: 'Очень подробно объясни, почему папка Green Screen может выглядеть пустой, минимум 30 пунктов.' });
  await sleep(2000);
  // Отметка берётся ДО abort: Pi присылает agent_settled внутри ожидания ответа
  // на abort (это же видел compat-check.mjs), поэтому ждать «нового» события
  // после ответа бессмысленно.
  const beforeAbort = rpc.events.length;
  const aborted = await rpc.send({ type: 'abort' }, timeoutMs).catch(error => ({ success: false, error: error.message }));
  let settledC = windowFrames(rpc, beforeAbort).find(frame => frame.type === 'agent_settled') || null;
  if (!settledC) settledC = await rpc.waitFor(record => record.type === 'agent_settled', timeoutMs).then(record => record, () => null);
  await sleep(500);
  const stateC = await rpc.send({ type: 'get_state' }).catch(() => null);
  const framesC = windowFrames(rpc, fromC);
  mark('C.abort_settles', aborted.success === true && settledC?.aborted === true && stateC?.data?.isStreaming === false, {
    abortAccepted: aborted.success === true,
    settledAborted: settledC?.aborted ?? null,
    streamingAfter: stateC?.data?.isStreaming ?? null,
    checkpointsAfterAbort: toolFrames(framesC, 'taskbridge_plan_checkpoint').length,
    settledInAbortWindow: windowFrames(rpc, beforeAbort).some(frame => frame.type === 'agent_settled')
  });

  // После STOP сессия должна принимать новый ход (resume), без повторной отправки.
  const fromR = rpc.events.length;
  const resumed = await rpc.send({ type: 'prompt', message: 'Ответь одним словом: ок' });
  const settledR = await rpc.waitFor(record => record.type === 'agent_settled', timeoutMs).then(record => record, () => null);
  mark('C.resume_after_abort', resumed.success === true && settledR?.aborted === false, {
    promptAccepted: resumed.success === true,
    settledAborted: settledR?.aborted ?? null,
    frames: windowFrames(rpc, fromR).length
  });
  await rpc.stop();
}

const report = { at: new Date().toISOString(), piVersion, model, extension: path.relative(repo, extension), results };
await fs.writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
const failed = Object.entries(results).filter(([, value]) => !value.ok);
console.log(`Pi: ${piVersion} | модель: ${model}`);
for (const [name, value] of Object.entries(results)) {
  const tag = value.skipped ? '﹣' : value.ok ? '✅' : '❌';
  console.log(`  ${tag} ${name}${value.skipped ? ` — ${value.skipped}` : ''}${value.detail ? ` — ${JSON.stringify(value.detail)}` : ''}`);
}
console.log(failed.length ? `\nНЕ подтверждено: ${failed.map(([name]) => name).join(', ')}` : '\nПоверхность FP-00 подтверждена на реальном Pi.');
console.log(`отчёт: ${path.relative(repo, path.join(out, 'report.json'))}`);
process.exitCode = failed.length ? 1 : 0;
