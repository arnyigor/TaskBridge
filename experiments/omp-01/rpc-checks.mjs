#!/usr/bin/env node
// OMP-01, §3 ТЗ: проверка RPC-протокола OMP отдельно от TaskBridge.
//
//   node experiments/omp-01/rpc-checks.mjs --model deepseek-flash
//
// Что проверяется (по docs/rpc.md, версия OMP 18.11.0):
//   1. `ready` и инициализация процесса;
//   2. `get_state`;
//   3. `prompt` (ответ + admit);
//   4. потоковые события текста и инструментов;
//   5. `prompt_result` — завершение конкретного запроса;
//   6. `session_settled` — сессия больше не может себя разбудить;
//   7. `steer` и `follow_up` во время генерации;
//   8. `abort`;
//   9. сохранение и повторное открытие сессии;
//  10. `rpc_chunk` (protocol v2) на крупных кадрах.
//
// Важное отличие от Pi: `prompt_result` и `session_settled` — разные вещи, и хост
// обязан ждать оба (иначе ответ показан, а сессия ещё живёт).
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OmpRpc, sleep, summarizeFrames } from './omp-rpc-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const model = argValue('--model', 'deepseek-flash');
const out = path.resolve(argValue('--out', path.join(repo, '.local', 'omp-01', `rpc-${Date.now()}`)));
const timeoutMs = Number(argValue('--timeout', '300000'));

await fs.mkdir(out, { recursive: true });
const workspace = path.join(out, 'workspace');
const sessions = path.join(out, 'sessions');
await fs.mkdir(sessions, { recursive: true });
await fs.mkdir(workspace, { recursive: true });
await fs.writeFile(path.join(workspace, 'notes.txt'), 'fixture\n');
// Файл больше физического лимита кадра (1 МиБ): чтобы получить его в кадре,
// просим агента прочитать файл целиком. Если инструмент обрежет чтение — чанки
// не появятся, и это будет видно в отчёте как «не воспроизведено».
const big = 'A'.repeat(1200 * 1024);
await fs.writeFile(path.join(workspace, 'big.txt'), `${big}\nLAST-LINE\n`);

const ompVersion = await new Promise(resolve => {
  const child = spawn('omp', ['--version'], { windowsHide: true, shell: process.platform === 'win32' });
  let text = '';
  child.stdout.on('data', chunk => { text += chunk; });
  child.on('exit', () => resolve(text.trim()));
});

const results = {};
const mark = (name, ok, detail = null) => {
  results[name] = { ok: Boolean(ok), detail };
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
};

const rpc = new OmpRpc({ cwd: workspace, args: ['--mode', 'rpc', '--no-ui', '--profile', 'omp01', '--session-dir', sessions, '--model', model] });

// 1. ready
const ready = await rpc.waitFor(frame => frame.type === 'ready', 60000).catch(() => null);
mark('ready', ready?.type === 'ready', ready ? { protocolVersion: ready.protocolVersion, supported: ready.supportedProtocolVersions, maxFrameBytes: ready.maxFrameBytes } : null);

// 10а. Согласование protocol v2 (нужно для rpc_chunk)
const negotiate = await rpc.send({ type: 'negotiate_protocol', protocolVersion: 2 }).catch(error => ({ success: false, error: error.message }));
mark('negotiate_protocol_v2', negotiate.success === true, negotiate.data || negotiate.error || null);

// 2. get_state
const state = await rpc.send({ type: 'get_state' }).catch(error => ({ success: false, error: error.message }));
mark('get_state', state.success === true, state.data ? { model: state.data.model?.id ?? state.data.modelId ?? null, isSettled: state.data.isSettled ?? null, keys: Object.keys(state.data).length } : state.error);

// 3–6. prompt: ответ, поток, prompt_result, session_settled
const before = rpc.frames.length;
const turn = await rpc.promptAndWait('Прочитай notes.txt и ответь одним словом, что в нём написано.', { timeoutMs });
const frames = turn.frames || [];
const deltas = frames.filter(frame => frame.type === 'message_update' && frame.assistantMessageEvent?.type === 'text_delta').length;
const toolStream = frames.some(frame => ['tool_execution_start', 'tool_execution_end', 'tool_execution_update'].includes(frame.type));
const summary = summarizeFrames(frames);
mark('prompt', turn.response.success === true, { agentInvoked: turn.response.data?.agentInvoked ?? null });
mark('stream_text', deltas > 0, { textDeltas: deltas, answerChars: summary.text.length });
mark('stream_tools', toolStream, { tools: summary.toolCalls.map(call => call.name).slice(0, 5) });
mark('prompt_result', turn.result?.type === 'prompt_result' && turn.result.status === 'completed', turn.result ? { status: turn.result.status, sessionSettled: turn.result.sessionSettled, agentInvoked: turn.result.agentInvoked } : null);
mark('session_settled', turn.settled === true, { settled: turn.settled });

// 7. steer и follow_up во время генерации
const slowBefore = rpc.frames.length;
const slow = await rpc.send({ type: 'prompt', message: 'Подробно разберись, зачем нужен файл big.txt в этом проекте, и опиши его структуру.' });
await sleep(1200);
const steer = await rpc.send({ type: 'steer', message: 'добавь одну строку про размер файла' }).catch(error => ({ success: false, error: error.message }));
const follow = await rpc.send({ type: 'follow_up', message: 'после ответа добавь итоговую строку' }).catch(error => ({ success: false, error: error.message }));
const queue = await rpc.waitFor(frame => frame.type === 'queue_update', 30000, { from: slowBefore }).catch(() => null);
const slowResult = await rpc.waitFor(frame => frame.type === 'prompt_result' && frame.id === slow.id, timeoutMs, { from: slowBefore }).catch(() => null);
await rpc.waitFor(frame => frame.type === 'session_settled', timeoutMs, { from: slowBefore }).catch(() => null);
mark('steer', steer.success === true, { queue: queue ? { steering: queue.steering?.length ?? null, followUp: queue.followUp?.length ?? null } : null });
mark('follow_up', follow.success === true, { status: slowResult?.status ?? null });

// 8. abort
const abortBefore = rpc.frames.length;
const longTurn = await rpc.send({ type: 'prompt', message: 'Очень подробно, шаг за шагом, опиши структуру каталога этого проекта и каждого файла в нём.' });
await sleep(1500);
const aborted = await rpc.send({ type: 'abort' }, timeoutMs).catch(error => ({ success: false, error: error.message }));
const abortResult = await rpc.waitFor(frame => frame.type === 'prompt_result' && frame.id === longTurn.id, timeoutMs, { from: abortBefore }).catch(() => null);
await sleep(1000);
const stateAfterAbort = await rpc.send({ type: 'get_state' }).catch(() => null);
mark('abort', aborted.success === true && stateAfterAbort?.data?.isStreaming !== true, {
  promptStatus: abortResult?.status ?? null,
  streaming: stateAfterAbort?.data?.isStreaming ?? null,
  settled: stateAfterAbort?.data?.isSettled ?? null,
});

// 9. Сохранение и повторное открытие сессии
const filesBefore = (await fs.readdir(sessions)).filter(name => name.endsWith('.jsonl')).length;
const sessionState = await rpc.send({ type: 'get_state' });
const sessionFile = sessionState.data?.sessionFile || null;
await rpc.stop();
let reopen = null;
if (sessionFile) {
  const second = new OmpRpc({ cwd: workspace, args: ['--mode', 'rpc', '--no-ui', '--profile', 'omp01', '--session-dir', sessions, '--model', model] });
  await second.waitFor(frame => frame.type === 'ready', 60000).catch(() => null);
  const opened = await second.send({ type: 'open_session', sessionDir: sessions }, 60000).catch(error => ({ success: false, error: error.message }));
  const continued = await second.promptAndWait('Ответь одним словом: продолжаем', { timeoutMs });
  reopen = { opened: opened.success === true, resumed: opened.data?.resumed ?? null, prompt: continued.response.success === true, settled: continued.settled };
  await second.stop();
}
mark('session_persist_reopen', filesBefore > 0 && reopen?.opened === true && reopen?.prompt === true, { sessionFiles: filesBefore, ...(reopen || {}) });

// 10б. rpc_chunk: кадр больше физического лимита (1 МиБ) обязан прийти
// сегментами. Детерминированный источник крупного кадра — каталог моделей
// (2 МБ и больше); чтение файла для этого не годится: инструмент ограничивает
// вывод, и кадр остаётся меньше лимита.
const bigRpc = new OmpRpc({ cwd: workspace, args: ['--mode', 'rpc', '--no-ui', '--profile', 'omp01', '--session-dir', sessions, '--model', model] });
const bigReady = await bigRpc.waitFor(frame => frame.type === 'ready', 60000).catch(() => null);
await bigRpc.send({ type: 'negotiate_protocol', protocolVersion: 2 }).catch(() => null);
const catalog = await bigRpc.send({ type: 'get_available_models' }, 180000).catch(error => ({ success: false, error: error.message }));
const catalogBytes = JSON.stringify(catalog).length;
const chunkSequences = bigRpc.chunkSequences;
await bigRpc.stop();
mark('rpc_chunk', chunkSequences > 0 && catalog.success === true && catalogBytes > (bigReady?.maxFrameBytes ?? 1048576), {
  chunkSequences,
  catalogBytes,
  maxFrameBytes: bigReady?.maxFrameBytes ?? null,
  note: chunkSequences > 0 ? null : 'кадр больше лимита, но сегментов не было',
});

const report = { at: new Date().toISOString(), omp: ompVersion, model, results };
await fs.writeFile(path.join(out, 'rpc-report.json'), `${JSON.stringify(report, null, 2)}\n`);
const failed = Object.values(results).filter(item => !item.ok).length;
console.log(`\n${Object.keys(results).length - failed}/${Object.keys(results).length} проверок пройдено; отчёт: ${path.relative(repo, path.join(out, 'rpc-report.json'))}`);
process.exitCode = failed ? 1 : 0;
