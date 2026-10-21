#!/usr/bin/env node
// Проверка RPC-поверхности установленного Pi (не TaskBridge): какие команды и
// события, на которые опирается TaskBridge, реально работают в этой версии.
//
//   node experiments/pi-hooks/compat-check.mjs --model deepseek/deepseek-flash
//
// Зачем: диапазон поддержки в src/pi-version.mjs (`SUPPORTED_PI`) — это заявление
// о совместимости, а не прочерк. Прежде чем его расширять, нужны факты именно
// про ту версию, что стоит на машине: prompt, steer, follow_up, set_model,
// compact, abort, get_state и перезапуск сохранённой сессии.
//
// Стенд изолирован: свой каталог агента (PI_CODING_AGENT_DIR), свой рабочий
// каталог, ключи провайдера из окружения. Настройки оператора не читаются.
import fs from 'node:fs/promises';
import os from 'node:os';
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
const timeoutMs = Number(argValue('--timeout', '120000'));
const out = path.resolve(argValue('--out', path.join(repo, '.local', 'core02', `compat-${Date.now()}`)));

await fs.mkdir(out, { recursive: true });
const workspace = path.join(out, 'workspace');
const sessions = path.join(out, 'sessions');
const agentDir = path.join(out, 'pi-agent');
await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
for (const dir of [workspace, sessions, agentDir]) await fs.mkdir(dir, { recursive: true });
await fs.writeFile(path.join(workspace, 'README.md'), '# compat\n');
// Сжатие требует сессии больше порога: на реальном каталоге оператора это
// меняло бы его настройки, здесь — свои.
await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 200 } }, null, 2));

const version = await new Promise(resolve => {
  const child = spawn('pi', ['--version'], { windowsHide: true, shell: process.platform === 'win32' });
  let text = '';
  child.stdout.on('data', chunk => { text += chunk; });
  child.on('exit', () => resolve(text.trim()));
});

const modelArgs = ['--provider', model.split('/')[0], '--model', model.split('/')[1]];
const env = { PI_CODING_AGENT_DIR: agentDir };
const results = {};
const mark = (name, ok, detail = null) => { results[name] = { ok, detail }; };

let rpc = new PiRpc({ cwd: workspace, args: ['--approve', '--session-dir', sessions, '--name', 'compat', ...modelArgs], env });
await rpc.send({ type: 'get_state' }).catch(() => null);

// 1. get_state
let state = await rpc.send({ type: 'get_state' });
mark('get_state', state.success === true && Boolean(state.data?.model || state.data?.modelId || state.data?.sessionFile), {
  keys: Object.keys(state.data || {}).slice(0, 12), model: state.data?.model?.id || state.data?.modelId || null,
});

// 2. prompt + agent_settled
const p1 = await rpc.send({ type: 'prompt', message: 'Ответь одним словом: ок' });
const settled1 = await rpc.waitFor(record => record.type === 'agent_settled', timeoutMs).then(() => true, () => false);
mark('prompt', p1.success === true && settled1, { disposition: p1.data?.disposition });

// 3. set_model
const switched = await rpc.send({ type: 'set_model', provider: model.split('/')[0], modelId: model.split('/')[1] });
mark('set_model', switched.success === true, { model: switched.data?.id || switched.data?.model?.id || null });

// 4. steer во время генерации
const slow1 = await rpc.send({ type: 'prompt', message: 'Подробно разберись, чем отличаются Chapter 01 и Chapter 02 в курсе Unreal Engine For Filmmakers.' });
await sleep(1500);
const steer = await rpc.send({ type: 'steer', message: 'добавь один пункт' });
mark('steer', steer.success === true, { disposition: steer.data?.disposition });
await rpc.waitFor(record => record.type === 'agent_settled', timeoutMs).catch(() => null);

// 5. follow_up во время генерации
const slow2 = await rpc.send({ type: 'prompt', message: 'Подробно разберись, какие разделы есть у курса Houdini.' });
await sleep(1200);
const followUp = await rpc.send({ type: 'follow_up', message: 'после ответа добавь одну строку' });
mark('follow_up', followUp.success === true, { disposition: followUp.data?.disposition });
await rpc.waitFor(record => record.type === 'agent_settled', timeoutMs).catch(() => null);
await sleep(1500);

// 6. compact (порог сжатия уменьшен в изолированном agent-dir)
const before = rpc.events.filter(record => record.type === 'compaction_end').length;
const compact = await rpc.send({ type: 'compact' }, timeoutMs).catch(error => ({ success: false, error: error.message }));
await sleep(1500);
const after = rpc.events.filter(record => record.type === 'compaction_end').length;
mark('compact', compact.success === true && after > before, { events: after - before, error: compact.error || null });

// 7. abort посреди хода.
// `agent_settled` приходит ВНУТРИ ожидания ответа на abort (Pi сначала гасит ход,
// потом отвечает), поэтому событие ищется с отметки ДО запроса, а не после.
const sqlow = rpc.events.length;
const slow3 = await rpc.send({ type: 'prompt', message: 'Очень подробно разберись, почему папка Green Screen может выглядеть пустой.' });
await sleep(1500);
const aborted = await rpc.send({ type: 'abort' }, timeoutMs);
await sleep(1000);
const settledAfterAbort = rpc.events.slice(sqlow).some(record => record.type === 'agent_settled');
const stateAfterAbort = await rpc.send({ type: 'get_state' }).catch(() => null);
mark('abort', aborted.success === true && settledAfterAbort, {
  settled: settledAfterAbort,
  streamingAfter: stateAfterAbort?.data?.isStreaming ?? null,
});

// 8. перезапуск сохранённой сессии
const files = (await fs.readdir(sessions)).filter(name => name.endsWith('.jsonl')).sort();
const sessionFile = files.length ? path.join(sessions, files.at(-1)) : null;
await rpc.stop();
let restoreOk = false;
let restoreDetail = null;
if (sessionFile) {
  rpc = new PiRpc({ cwd: workspace, args: ['--approve', '--session', sessionFile, '--session-dir', sessions, ...modelArgs], env });
  const st = await rpc.send({ type: 'get_state' }).catch(error => ({ success: false, error: error.message }));
  const p = await rpc.send({ type: 'prompt', message: 'Продолжи: ответь одним словом.' }).catch(error => ({ success: false, error: error.message }));
  const settled = await rpc.waitFor(record => record.type === 'agent_settled', timeoutMs).then(() => true, () => false);
  restoreOk = st.success === true && p.success === true && settled;
  restoreDetail = { getState: st.success === true, prompt: p.success === true, settled };
  await rpc.stop();
}
mark('restart_saved_session', restoreOk, restoreDetail);

const report = { at: new Date().toISOString(), piVersion: version, model, results };
await fs.writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
const failed = Object.entries(results).filter(([, value]) => !value.ok);
console.log(`Pi: ${version} | модель: ${model}`);
for (const [name, value] of Object.entries(results)) console.log(`  ${value.ok ? '✅' : '❌'} ${name}${value.detail ? ` — ${JSON.stringify(value.detail)}` : ''}`);
console.log(failed.length ? `\nНЕ подтверждено: ${failed.map(([name]) => name).join(', ')}` : '\nВсе проверки RPC-поверхности пройдены.');
console.log(`отчёт: ${path.relative(repo, path.join(out, 'report.json'))}`);
process.exitCode = failed.length ? 1 : 0;
