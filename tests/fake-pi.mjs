import readline from 'node:readline';
import fs from 'node:fs';
import crypto from 'node:crypto';
// `pi --version`, as TaskBridge probes it at startup. Overridable so tests can
// play an unsupported Pi.
if (process.argv.includes('--version')) {
  process.stdout.write(`${process.env.FAKE_PI_VERSION || '0.85.1'}\n`);
  process.exit(0);
}
// FAKE_PI_GATE_DIR: тест придерживает старт Pi (файл hold) и отпускает (release).
// Нужно, чтобы STOP гарантированно попадал в окно «работа снята с очереди, но ход
// ещё не начался» (STAB-02A) — без таймеров и задержек в production коде.
const gateDir = process.env.FAKE_PI_GATE_DIR;
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (gateDir && fs.existsSync(`${gateDir}/hold`)) {
  fs.writeFileSync(`${gateDir}/parked`, '1');
  const deadline = Date.now() + 120000;
  while (!fs.existsSync(`${gateDir}/release`) && Date.now() < deadline) sleepSync(20);
}

// Заслонка на конкретной RPC (STAB-02A): арм-файл `arm-<name>` задерживает ответ на
// эту команду до `release-<name>`. В отличие от стартовой заслонки выше обработчик
// остаётся живым: остальные кадры (в том числе abort) продолжают обрабатываться.
// Так STOP попадает в окно «сообщение уже передаётся», а не убивает процесс.
async function parkOn(name) {
  if (!gateDir) return;
  const arm = `${gateDir}/arm-${name}`;
  if (!fs.existsSync(arm)) return;
  fs.unlinkSync(arm);
  fs.writeFileSync(`${gateDir}/parked-${name}`, '1');
  const deadline = Date.now() + 60000;
  while (!fs.existsSync(`${gateDir}/release-${name}`) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const sessionArg = process.argv.indexOf('--session');
const sessionFile = sessionArg >= 0 ? process.argv[sessionArg + 1] : null;
// Tests that check how TaskBridge launches Pi (extensions, media policy env) read
// this dump instead of guessing from behaviour.
if (process.env.FAKE_PI_DUMP_ARGS) {
  fs.writeFileSync(process.env.FAKE_PI_DUMP_ARGS, JSON.stringify({
    argv: process.argv.slice(2),
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('TASKBRIDGE_MEDIA_')))
  }));
}
const argValue = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
let model = { id: argValue('--model') || 'fixture', provider: argValue('--provider') || null, contextWindow: 65536, maxTokens: 1024 };
let thinkingLevel = argValue('--thinking') || 'off';
const entries = sessionFile ? fs.readFileSync(sessionFile, 'utf8').trim().split('\n').map(x => JSON.parse(x)) : [];
const messages = entries.filter(x => x.type === 'message').map(x => x.message);
let parentId = entries.at(-1)?.id || null;
function persist(message) {
  messages.push(message);
  if (sessionFile) {
    const entry = { type: 'message', id: crypto.randomUUID().slice(0, 8), parentId, timestamp: new Date().toISOString(), message };
    fs.appendFileSync(sessionFile, JSON.stringify(entry) + '\n');
    parentId = entry.id;
  }
}
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const FIXTURE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAAAh0lEQVR42u3bsQ3AIAwAwTjKMIyQSSgYMAWTeKwsEKgiQXHfukEnuyRKy0PjTgSAAAECBAgQIED66pqPs9VVL7ufboOcGCBAgAQIECBAgAABAiRAgAABAgQIECABAgQIECBAgAABQgAIECBAgAABAiRAgP4vfMm0QYAAAQIECBAgAQIECNBuvaKJBhXtF+1iAAAAAElFTkSuQmCC';
let streaming = false;
let pending;
let automatic = true;
let queueCrashFired = false;
let turn = messages.filter(x => x.role === 'assistant').length;
const state = () => ({ sessionFile, messageCount: messages.length, isStreaming: streaming, isCompacting: false, autoCompactionEnabled: automatic, model, thinkingLevel });
const availableModels = [
  { provider: 'fixture', id: 'fixture', name: 'Fixture', contextWindow: 65536, maxTokens: 1024, reasoning: true, input: ['text'] },
  { provider: 'other', id: 'other', name: 'Other', contextWindow: 8000, maxTokens: 512, reasoning: false, input: ['text', 'image'] }
];

// Stands in for the real TaskBridge approval extension: asks the local endpoint
// before a "tool" runs and blocks until the operator answers.
async function approvalGate(toolCallId, toolName, args) {
  const base = process.env.TASKBRIDGE_APPROVAL_URL;
  const token = process.env.TASKBRIDGE_APPROVAL_TOKEN;
  const taskId = process.env.TASKBRIDGE_TASK_ID;
  if (!base || !token || !taskId) return 'ALLOW_ONCE';
  const headers = { 'content-type': 'application/json', 'x-taskbridge-approval': token };
  const endpoint = `${base}/api/tasks/${encodeURIComponent(taskId)}/approval`;
  const start = await (await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ toolCallId, toolName, args }) })).json();
  if (start.status !== 'PENDING') return start.status;
  for (let i = 0; i < 300; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    const polled = await (await fetch(`${endpoint}/${encodeURIComponent(start.approvalId)}`, { headers })).json();
    if (polled.status !== 'PENDING') return polled.status;
  }
  return 'TIMEOUT';
}
// The answer arrives as several deltas a few ms apart, like a streamed
// response: that is what lets TaskBridge measure TG from usage (output tokens
// over the time the deltas actually spanned).
// --- Follow Plan stand-in ---------------------------------------------------
// Parses the FOLLOW PLAN instruction and builds the checkpoint a compliant model
// would send. Returns null when the instruction is not a normal step (the audit
// turn, for instance) or the plan cannot be read — the controller must then ask
// once and pause, which the tests exercise separately.
function followPlanCheckpoint(message, proofRef = null) {
  const file = /`([^`]+\.md)`/.exec(message);
  const planId = /planId\s+(p-[\w-]+)/.exec(message);
  const revision = /revision\s+(\d+)/.exec(message);
  // «cycle c-1).» — the instruction ends the parenthesis, so the id is matched by
  // its own shape rather than by "everything up to a space".
  const cycleId = /cycle\s+(c-[\w-]+)/.exec(message);
  const stepId = /Текущий шаг:\s*(S-\d+)/.exec(message);
  const runId = /прогона[^:]*:\s*([0-9a-f-]{36})/i.exec(message);
  if (!file || !planId || !revision || !cycleId || !stepId) return null;
  let text;
  try { text = fs.readFileSync(file[1], 'utf8'); } catch { return null; }
  const statuses = [...text.matchAll(/^###\s+(S-\d+)\s*\|\s*([A-Z_]+)/gm)].map(match => ({ id: match[1], status: match[2] }));
  if (!statuses.some(step => step.id === stepId[1])) return null;
  // Один разбор заголовка текущего шага: он же решает про медленный ход,
  // повторный settle и отсутствие checkpoint.
  const headingLine = text.split('\n').find(line => line.startsWith(`### ${stepId[1]}`)) || '';
  if (headingLine.includes('slow')) planSlow = true;
  if (headingLine.includes('double-settle')) planDoubleSettle = true;
  const left = statuses.filter(step => step.id !== stepId[1] && step.status !== 'DONE' && step.status !== 'SKIPPED');
  // `finding-P1` в заголовке шага: этот ход «находит» связанный дефект — так
  // проверяется автоправка плана (FP-04/FP-05D) на уровне HTTP.
  const finding = /finding-(P\d)/.exec(text.split('\n').find(line => line.startsWith(`### ${stepId[1]}`)) || '');
  if (headingLine.includes('no-checkpoint')) return null;
  const findings = finding
    ? [{ id: 'F-900', priority: finding[1], blocking: finding[1] === 'P0' || finding[1] === 'P1', summary: 'дефект, найденный в шаге' }]
    : [];
  // `manual-only` в заголовке шага: модель присылает только описание сверки —
  // так проверяется правило «manual допустим там, где план не даёт проверки».
  if (headingLine.includes('manual-only')) {
    return {
      planId: planId[1],
      revision: Number(revision[1]),
      cycleId: cycleId[1],
      decision: left.length ? 'CONTINUE' : 'COMPLETE',
      completedStepIds: [stepId[1]],
      evidence: [{ stepId: stepId[1], kind: 'manual', summary: 'fixture: сверено вручную по документам' }],
      findings: []
    };
  }
  const evidence = [
    ...(runId
      ? [{ stepId: stepId[1], kind: 'run', ref: runId[1], summary: 'fixture: шаг выполнен' }]
      : [{ stepId: stepId[1], kind: 'file', ref: file[1], summary: 'fixture: шаг выполнен' }]),
    // …and the proof tool call actually emitted for this same turn.
    ...(proofRef ? [{ stepId: stepId[1], kind: 'command', ref: proofRef, summary: 'fixture: инструмент отработал без ошибки' }] : [])
  ];
  return {
    // The runner turns this into a failed tool end and drops the field.
    ...(headingLine.includes('checkpoint-error') ? { __failed: true } : {}),
    planId: planId[1],
    revision: Number(revision[1]),
    cycleId: cycleId[1],
    decision: left.length ? 'CONTINUE' : 'COMPLETE',
    completedStepIds: [stepId[1]],
    evidence,
    findings
  };
}

function finish(text, fail = false, errorMessage = 'Fixture model error', thinking = null) {
  // `stream-many` answers are long: one delta per character, so a client can
  // (re)connect in the middle of a stream.
  const parts = text.length > 40 ? [...text] : text.length >= 3 ? [text.slice(0, 1), text.slice(1, 2), text.slice(2)] : [text];
  let index = 0;
  const emit = () => {
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: parts[index] } });
    index += 1;
    if (index < parts.length) { setTimeout(emit, parts.length > 40 ? 8 : 25); return; }
    // Reasoning arrives as a `thinking` content part, not as a stream of deltas:
    // on the live server 159 sessions carried 1002 such parts and zero
    // thinking_delta frames (models in use do not stream reasoning).
    const content = [...(thinking ? [{ type: 'thinking', thinking }] : []), { type: 'text', text }];
    const message = { role: 'assistant', content, usage: { input: 1000, output: 100, totalTokens: 1100 }, stopReason: fail ? 'error' : 'stop', ...(fail ? { errorMessage } : {}) };
    persist(message);
    send({ type: 'message_end', message });
    streaming = false;
    // Real Pi repeats the whole conversation in `agent_end` (messages and all);
    // the fixture does the same, so the code that decides what is worth storing
    // and shipping is exercised by it rather than by a shape that never happens.
    send({ type: 'agent_end', messages: [message] });
    send({ type: 'agent_settled' });
  };
  emit();
}
// --- failure modes (backend plan B0) --------------------------------------
// A prompt containing `fault-<name>` makes this stand-in misbehave the way a
// real Pi (or the pipe to it) can. Everything else keeps the normal script.
//   fault-crash   exits with code 3 in the middle of a tool call, after stderr
//   fault-garbage writes a non-JSON line and a torn JSON line, then answers
//   fault-utf8    answers with Cyrillic text whose bytes are split across writes
//   fault-hang    acknowledges the prompt, starts a tool and never finishes
//   fault-deaf    like fault-hang, and ignores abort too
//   fault-child   starts a long-lived child process (like pytest), then hangs;
//                 its pid is reported on stderr as `fake-pi child <pid>`
//   fault-deaf-stream  ignores abort and goes on streaming deltas meanwhile
//   fault-queue-crash accepts a message into its own queue (queue_update) and
//                 exits before the turn that would consume it — the
//                 lost-message shape (steer accepted, then Pi died)
//   fault-abort-tail   answers abort, then starts another turn 0.5 s later (the
//                 tail it had already queued when the abort arrived)
//   fault-abort-tail   answers abort, then starts another turn 0.5 s later (the
//                 tail it had already queued when the abort arrived)
//   fault-notices emits the retry-in-progress notices a live model produces while
//                 it is being retried, plus one genuine error notice, then answers
//                 normally — the chat must keep only the genuine one
//   fault-provider-wait  the provider refuses the request (HTTP 429 with
//                 retry-after) and Pi announces the wait twice, then nothing:
//                 the reported shape of a session that looked idle-but-working
//                 for 90 minutes (2026-10-09)
//   fault-provider-flap  one retry episode announced by every shape Pi uses:
//                 its own sentence, the extension's sentence and the machine
//                 frame — one `periodId`, then a tick inside it and a new
//                 episode (2026-10-12)
//   fault-provider-give-up  the extension announces a retry, then gives up
//                 («… failed and pi-limits-wait is not retrying: …»): the wait
//                 state must not survive it (2026-10-12)
//   fault-slow-stream  streams 8 tokens with a 3 s pause in the middle: a local
//                 engine chunking slowly, where the pause IS generation time
let deaf = false;
let tailAfterAbort = false;
// A step whose heading says `slow` takes 10 s in the fixture: the STOP test needs
// a turn that is still running when the operator presses the button.
let planSlow = false;
// Repeats `agent_settled` after the turn: the shape a reconnect or a duplicated
// frame produces. The controller must not start another cycle from it.
let planDoubleSettle = false;
function faultOf(message) {
  const match = String(message || '').match(/fault-(queue-crash|crash|garbage|utf8|hang|deaf-stream|abort-tail|deaf|child|notices|heavy-mixed|provider-incompatible|provider-wait|provider-flap|provider-give-up|slow-stream)/);
  return match ? match[1] : null;
}
function startTurn(message) {
  streaming = true;
  planSlow = false;
  planDoubleSettle = false;
  turn += 1;
  send({ type: 'agent_start' });
  const user = { role: 'user', content: [{ type: 'text', text: message }] };
  persist(user);
  send({ type: 'message_start', message: user });
  send({ type: 'message_end', message: user });
  send({ type: 'message_start', message: { role: 'assistant', content: [] } });
  // `no-tools`: ход без единого инструмента; `read-only`: только чтение картинки —
  // оба случая проверяют автоповтор после 413 там, где повторять нечего (MEDIA-09A).
  const messageText = String(message || '');
  const withTools = !messageText.includes('no-tools');
  const readOnly = messageText.includes('read-only');
  if (withTools) send({ type: 'tool_execution_start', toolCallId: `call-${turn}`, toolName: readOnly ? 'read' : 'bash', args: readOnly ? { path: 'shot.png' } : { command: 'pytest' } });
}
async function runFault(fault, command, respond) {
  respond();
  // queue-crash dies before the turn that would consume the message: no
  // startTurn, the user message must stay out of the session file — otherwise
  // the failure looks like a consumed prompt and the re-queue has nothing to
  // bring back.
  if (fault === 'queue-crash') {
    // Only the first delivery dies: the re-delivered message consumes normally,
    // so a test can assert the re-queue is spent, not a retry loop.
    if (!queueCrashFired) {
      queueCrashFired = true;
      send({ type: 'queue_update', steering: [command.message], followUp: [] });
      setTimeout(() => process.exit(3), 20);
      return;
    }
  }
  startTurn(command.message);
  if (fault === 'crash') {
    process.stderr.write('fake-pi: simulated crash during a tool call\n');
    setTimeout(() => process.exit(3), 20);
    return;
  }
  if (fault === 'garbage') {
    process.stdout.write('this is not json at all\n');
    process.stdout.write('{"type":"message_update","assistantMessageEvent":\n');
    send({ type: 'tool_execution_end', toolCallId: `call-${turn}`, toolName: 'bash', isError: false });
    finish('после мусора');
    return;
  }
  if (fault === 'heavy-mixed') {
    send({ type: 'tool_execution_end', toolCallId: `call-${turn}`, toolName: 'bash', isError: false });
    const block = '  \n' + 'Разбор кода, reasoning и bash-команд.\n'.repeat(7000) + '\n  ';
    for (let part = 0; part < 3; part++) {
      const text = (part ? '\n\n' : '') + block;
      for (let offset = 0; offset < text.length; offset += 16000) {
        send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: text.slice(offset, offset + 16000) } });
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (part === 0 && String(command.message).includes('gated')) {
        const started = Date.now();
        while (!fs.existsSync('heavy-stream.release')) {
          if (Date.now() - started > 60000) throw new Error('Heavy stream gate was not released');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
    }
    const tools = [];
    for (let index = 0; index < 120; index++) {
      const name = ['bash', 'read', 'edit', 'write'][index % 4];
      const args = name === 'bash' ? { command: `echo operation-${index}` } : { path: `mixed/file-${index}.kt`, oldText: 'old', newText: 'new', content: 'created' };
      const id = `mixed-${turn}-${index}`;
      tools.push({ type: 'toolCall', id, name, arguments: args });
      send({ type: 'tool_execution_start', toolCallId: id, toolName: name, args });
      send({ type: 'tool_execution_end', toolCallId: id, toolName: name, isError: false, result: { content: [{ type: 'text', text: `Result ${index}\n` + 'output line\n'.repeat(20) }] } });
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const text = 'HEAVY_MIXED_STREAM_OK';
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
    const message = { role: 'assistant', content: [...Array.from({ length: 3 }, () => ({ type: 'thinking', thinking: block })), ...tools, { type: 'text', text }], stopReason: 'stop' };
    persist(message);
    send({ type: 'message_end', message });
    streaming = false;
    send({ type: 'agent_end', messages: [message] });
    send({ type: 'agent_settled' });
    return;
  }
  if (fault === 'slow-stream') {
    // 8 tokens over ~3.4 s with one 3 s pause inside the SAME message: the pause
    // is the engine generating slowly, not a tool call between messages. Output
    // and timing are exact, so the reported TG has a known expected value (~2.4
    // tok/s; the old gap-summing arithmetic said ~11).
    const delta = () => send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } });
    for (let i = 0; i < 4; i++) { delta(); await new Promise(resolve => setTimeout(resolve, 120)); }
    await new Promise(resolve => setTimeout(resolve, 3000));
    for (let i = 0; i < 4; i++) { delta(); await new Promise(resolve => setTimeout(resolve, 120)); }
    send({ type: 'tool_execution_end', toolCallId: `call-${turn}`, toolName: 'bash', isError: false });
    const message = { role: 'assistant', content: [{ type: 'text', text: 'медленный поток' }], usage: { input: 1000, output: 8, totalTokens: 1008 }, stopReason: 'stop' };
    persist(message);
    send({ type: 'message_end', message });
    streaming = false;
    send({ type: 'agent_end' });
    send({ type: 'agent_settled' });
    return;
  }
  if (fault === 'notices') {
    // Verbatim shapes from a live session (2026-09-29) with a local model that
    // was being restarted: the two retry-in-progress lines and a real failure.
    send({ type: 'extension_ui_request', id: 'notice-retry', method: 'notify', notifyType: 'info',
      message: 'strata-iq3/qwen3.8-flash-next-iq3-xxs retrying after error in 0m 05s. Error: Connection error.' });
    send({ type: 'extension_ui_request', id: 'notice-wait', method: 'notify', notifyType: 'info',
      message: '⏳ pi-limits-wait: retrying after error on strata-iq3/qwen3.8-flash-next-iq3-xxs; still alive, waiting 0m 05s before the next retry. Why: Connection error.' });
    send({ type: 'extension_ui_request', id: 'notice-rate', method: 'notify', notifyType: 'warning',
      message: '⏳ pi-limits-wait: rate limited on wormsoft/qwen/qwen3.8:27b; still alive, waiting 0m 30s before the next retry. Why: HTTP 429' });
    send({ type: 'extension_ui_request', id: 'notice-real', method: 'notify', notifyType: 'error',
      message: 'Smart compaction failed safely and was cancelled: Connection error.' });
    send({ type: 'tool_execution_end', toolCallId: `call-${turn}`, toolName: 'bash', isError: false });
    finish('после уведомлений');
    return;
  }
  if (fault === 'utf8') {
    send({ type: 'tool_execution_end', toolCallId: `call-${turn}`, toolName: 'bash', isError: false });
    const text = 'Привет, мир — ёжик';
    const message = { role: 'assistant', content: [{ type: 'text', text }], usage: { input: 10, output: 5, totalTokens: 15 }, stopReason: 'stop' };
    persist(message);
    const bytes = Buffer.from(JSON.stringify({ type: 'message_end', message }) + '\n', 'utf8');
    // Cut inside the first multi-byte character, and again a few bytes later,
    // flushing between writes so the reader sees separate chunks.
    const cut = bytes.indexOf(Buffer.from('П', 'utf8')) + 1;
    const writes = [bytes.subarray(0, cut), bytes.subarray(cut, cut + 3), bytes.subarray(cut + 3)];
    for (const part of writes) {
      await new Promise(resolve => process.stdout.write(part, resolve));
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    streaming = false;
    send({ type: 'agent_end' });
    send({ type: 'agent_settled' });
    return;
  }
  // deaf and child combine: `fault-deaf fault-child` is a hung tool that
  // ignores abort and holds a child process.
  if (fault === 'provider-incompatible') {
    // `body-limit` is the permanent 413 a provider edge answers when the request
    // body (a transcript full of base64 screenshots) is over its limit.
    const error = String(command.message).includes('invalid-auth') ? 'HTTP 401: invalid API key'
      : String(command.message).includes('empty-quota') ? 'HTTP 402: insufficient credits'
      : String(command.message).includes('body-limit') ? '413 Failed to buffer the request body: length limit exceeded'
      : `OpenAI API error (400): 400 {"detail":"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account."}`;
    // `body-limit` also grows the transcript the way a real turn does: a tool
    // read a screenshot, the file got big and the NEXT request is refused. The
    // session file is what TaskBridge's preflight repairs.
    // `body-limit-text` — тот же 413, но история НЕ растёт: она и так текстовая и
    // уже больше, чем провайдер принимает, поэтому уменьшать в ней нечего (MEDIA-08D).
    if (error.includes('413') && sessionFile && !String(command.message).includes('body-limit-text')) {
      for (const n of ['a', 'b', 'c']) {
        persist({ role: 'toolResult', toolCallId: `call-img-${n}`, toolName: 'read', isError: false, content: [
          { type: 'text', text: 'Read image file [image/png]' },
          { type: 'image', data: 'A'.repeat(9 * 1024 * 1024), mimeType: 'image/png' }
        ] });
      }
    }
    // Заранее взведённая заслонка для следующего запуска Pi (STAB-02A): 413 уже
    // отправлен, значит следующий spawn — это продолжение из очереди.
    if (process.env.FAKE_PI_GATE_ARM_ON_413) {
      const gateDir = process.env.FAKE_PI_GATE_DIR;
      if (gateDir) fs.writeFileSync(`${gateDir}/hold`, '1');
    }
    const notice = `openai/gpt-5.5 retrying after error in 0m 05s. Error: ${error}`;
    // Какие инструменты успели выполниться до отказа провайдера: от этого зависит,
    // безопасен ли автоматический повтор (MEDIA-09D). `no-tools` — ход без
    // инструментов вообще; `tools-ran` — уже выполненная запись файла; по умолчанию
    // bash без результата (в свидетельства не попадает).
    const asked = String(command.message);
    if (!asked.includes('no-tools')) {
      const toolName = asked.includes('tools-ran') ? 'write' : asked.includes('read-only') ? 'read' : 'bash';
      send({ type: 'tool_execution_start', toolCallId: `call-${turn}`, toolName, args: { path: 'src/example.mjs' } });
      send({ type: 'tool_execution_end', toolCallId: `call-${turn}`, toolName, isError: false, result: { content: [{ type: 'text', text: 'Файл записан' }] } });
    }
    if (String(command.message).includes('structured')) {
      send({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'test.pi-limits-wait.json', statusText: JSON.stringify({ event: 'wait', error, model: { provider: 'openai', id: 'gpt-5.5' }, remainingMs: 5000, plannedDeadline: Date.now() + 5000 }) });
    } else send({ type: 'extension_ui_request', method: 'notify', notifyType: 'info', message: notice });
    // A retry tail must never reopen a terminal failure.
    setTimeout(() => { send({ type: 'agent_start' }); send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'unexpected retry' } }); }, 150);
    return;
  }
  if (fault === 'provider-wait') {
    // Verbatim from a live session (2026-10-09): wormsoft answered HTTP 429
    // «user reached the limit» with `retry-after-ms 5452000`, and the extension
    // announced the same ~1h31m wait every 15 s. Two announcements here — the
    // same round, so the tick must not become a second note — then silence.
    const startedAt = Date.now();
    const deadline = startedAt + 5_472_000;
    // «Ждать осталось столько-то» для всех объявлений одного раунда: остаток —
    // это дедлайн минус текущий момент, поэтому текстовое и машинное объявления
    // указывают на один и тот же момент повтора (у живой сессии было именно так).
    const waitNotice = () => {
      const left = Math.round((deadline - Date.now()) / 1000);
      const remaining = `${Math.floor(left / 3600)}h ${Math.floor((left % 3600) / 60)}m ${left % 60}s`;
      return `⏳ pi-limits-wait: rate limited on wormsoft/anthropic/claude-opus-5.5; still alive, waiting ${remaining} before the next retry. Why: HTTP 429 retry-after-ms 5452000; Error: 429: {"statusCode":429,"message":"user reached the limit","timestamp":"2026-10-09T23:08:52.863Z"}`;
    };
    // The tool result is in and the model call is what the provider refused.
    send({ type: 'tool_execution_end', toolCallId: `call-${turn}`, toolName: 'bash', isError: false });
    // Both shapes the extension emits for one wait: the machine-readable frame
    // (provider, model, reason, plannedDeadline) and the human sentence that
    // follows it. One round — one report, whichever source is read first.
    send({ type: 'extension_ui_request', id: 'wait-json-1', method: 'setStatus', statusKey: 'oira666.pi-limits-wait.json', statusText: JSON.stringify({
      v: 1, ext: '0.6.5', event: 'wait', waitId: 'wait-1', periodId: 'period-1', reason: 'rate-limit',
      message: waitNotice(),
      error: 'HTTP 429 retry-after-ms 5452000; Error: 429: {"statusCode":429,"message":"user reached the limit","timestamp":"2026-10-09T23:08:52.863Z"}',
      model: { provider: 'wormsoft', id: 'anthropic/claude-opus-5.5' },
      plannedDurationMs: 5_472_000, plannedDeadline: deadline, startedAt, remainingMs: deadline - Date.now(),
      attempt: null, maxAttempts: null, livelinessIntervalMs: 15000, controlFile: null,
    }) });
    send({ type: 'extension_ui_request', id: 'wait-1', method: 'notify', notifyType: 'info', message: waitNotice() });
    setTimeout(() => send({ type: 'extension_ui_request', id: 'wait-2', method: 'notify', notifyType: 'info', message: waitNotice() }), 120);
    return;
  }
  if (fault === 'provider-flap') {
    // Живая сессия 2026-10-12 (openai-codex/gpt-5.6-sol): один эпизод отказа Pi
    // объявляет трижды и разными словами — сам («<модель> network/timeout error
    // for 0m 15s; waiting, then retrying. Error: fetch failed»), расширение
    // («⏳ pi-limits-wait: network/timeout error on <модель>; … Why: fetch failed»)
    // и машинным кадром с тем же `periodId`. Внутри эпизода причина и срок
    // меняются (retry, 5 с), после чего эпизод закрывается своим ходом.
    const startedAt = Date.now();
    const waitFrame = (id, periodId, reason, durationMs, message) => send({
      type: 'extension_ui_request', id, method: 'setStatus', statusKey: 'oira666.pi-limits-wait.json',
      statusText: JSON.stringify({
        v: 1, ext: '0.7.0', event: 'wait', waitId: id, periodId, reason, message, error: 'fetch failed',
        model: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
        plannedDurationMs: durationMs, plannedDeadline: startedAt + durationMs, startedAt,
        remainingMs: durationMs, attempt: 1, maxAttempts: null, livelinessIntervalMs: 15000, controlFile: null,
      }),
    });
    const notice = (id, message) => send({ type: 'extension_ui_request', id, method: 'notify', notifyType: 'info', message });
    const extensionProse = (clock) => `⏳ pi-limits-wait: network/timeout error on openai-codex/gpt-5.6-sol; still alive, waiting ${clock} before the next retry. Why: fetch failed`;
    send({ type: 'tool_execution_end', toolCallId: `call-${turn}`, toolName: 'bash', isError: false });
    notice('flap-core-1', 'openai-codex/gpt-5.6-sol network/timeout error for 0m 15s; waiting, then retrying. Error: fetch failed');
    waitFrame('flap-json-1', 'period-flap-1', 'network', 15000, extensionProse('0m 15s'));
    notice('flap-ext-1', extensionProse('0m 15s'));
    setTimeout(() => {
      // Тик того же эпизода: другой `waitId`, другая причина и срок, `periodId` тот же.
      waitFrame('flap-json-2', 'period-flap-1', 'retry', 5000, '⏳ pi-limits-wait: retrying after error on openai-codex/gpt-5.6-sol; still alive, waiting 0m 05s before the next retry. Why: fetch failed');
      notice('flap-core-2', 'openai-codex/gpt-5.6-sol retrying after error in 0m 05s. Error: fetch failed');
    }, 120);
    // Новый эпизод: другой `periodId` — об этом уже надо сказать снова.
    setTimeout(() => waitFrame('flap-json-3', 'period-flap-2', 'retry', 5000, '⏳ pi-limits-wait: retrying after error on openai-codex/gpt-5.6-sol; still alive, waiting 0m 05s before the next retry. Why: fetch failed'), 260);
    setTimeout(() => finish('после повтора провайдера'), 420);
    return;
  }
  if (fault === 'provider-give-up') {
    // 2026-10-12: отказ, после которого повтора НЕ будет. Расширение говорит об этом двумя
    // способами — прозой («<модель> failed and pi-limits-wait is not retrying: <причина>»)
    // и машинным кадром `give_up` (без полей model/periodId: модель и причина — в тексте).
    // Сначала обычное ожидание: оно взводит состояние «ждём провайдера».
    send({ type: 'tool_execution_end', toolCallId: `call-${turn}`, toolName: 'bash', isError: false });
    send({
      type: 'extension_ui_request', id: 'give-wait-1', method: 'setStatus', statusKey: 'oira666.pi-limits-wait.json',
      statusText: JSON.stringify({
        v: 1, ext: '0.6.5', event: 'wait', waitId: 'wait-give-1', periodId: 'period-give-1', reason: 'retry',
        message: '⏳ pi-limits-wait: retrying after error on strata-iq3/qwen3.8-flash; still alive, waiting 0m 15s before the next retry. Why: Connection error.',
        error: 'Connection error.', model: { provider: 'strata-iq3', id: 'qwen3.8-flash' },
        plannedDurationMs: 15000, plannedDeadline: Date.now() + 15000, startedAt: Date.now(), remainingMs: 15000,
        attempt: 1, maxAttempts: null, livelinessIntervalMs: 15000, controlFile: null,
      }),
    });
    const giveUp = 'strata-iq3/qwen3.8-flash failed and pi-limits-wait is not retrying: Connection error.';
    send({ type: 'extension_ui_request', id: 'give-notify', method: 'notify', notifyType: 'info', message: giveUp });
    send({
      type: 'extension_ui_request', id: 'give-json', method: 'setStatus', statusKey: 'oira666.pi-limits-wait.json',
      statusText: JSON.stringify({
        v: 1, ext: '0.6.5', event: 'give_up', waitId: null, reason: null, message: giveUp, error: 'Connection error.',
        plannedDurationMs: null, plannedDeadline: null, startedAt: null, remainingMs: null, attempt: null,
        maxAttempts: null, livelinessIntervalMs: 15000, controlFile: null,
      }),
    });
    // Ход остаётся открытым: состояние ожидания обязано сняться ДО терминального статуса.
    return;
  }
  if (command.message.includes('fault-deaf')) deaf = true;
  if (command.message.includes('fault-child')) {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.stderr.write(`fake-pi child ${child.pid}\n`);
  }
  // hang / deaf / child / abort-tail: the tool never finishes on its own.
  if (fault === 'abort-tail') { tailAfterAbort = true; return; }
  if (fault === 'deaf-stream') {
    // Still streaming when the abort arrives: every frame re-arms a pending
    // request's idle timer, so this is the shape that stretched a STOP.
    deaf = true;
    setInterval(() => send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'всё ещё думаю' } }), 50);
    return;
  }
}

readline.createInterface({ input: process.stdin }).on('line', async line => {
  const command = JSON.parse(line);
  const respond = (data = {}, success = true) => send({ type: 'response', id: command.id, command: command.type, success, data, ...(!success ? { error: 'Fixture rejected prompt' } : {}) });
  if (command.type === 'get_state') return respond(state());
  // Pi's own context estimate. FAKE_PI_CONTEXT_TOKENS pins it so a test can put
  // the session over a context limit on purpose; otherwise it is derived from
  // the transcript like Pi's chars/4 heuristic.
  if (command.type === 'get_session_stats') {
    const pinned = Number(process.env.FAKE_PI_CONTEXT_TOKENS || 0);
    const derived = Math.ceil(messages.reduce((sum, message) =>
      sum + JSON.stringify(message.content ?? '').length, 0) / 4);
    const tokens = pinned > 0 ? pinned : derived;
    const contextWindow = model.contextWindow ?? null;
    return respond({
      sessionFile: sessionFile ?? undefined,
      sessionId: 'fixture-session',
      userMessages: messages.filter(x => x.role === 'user').length,
      assistantMessages: messages.filter(x => x.role === 'assistant').length,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: messages.length,
      tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens },
      cost: 0,
      contextUsage: contextWindow
        ? { tokens, contextWindow, percent: Math.round((tokens / contextWindow) * 100) }
        : { tokens, contextWindow: null, percent: null },
    });
  }
  // The command list TaskBridge asks for before deciding how to deliver a slash text.
  // 'nudge' is the extension command the delivery test drives; the fake does not run
  // commands — it only has to be honest about which ones exist.
  if (command.type === 'get_commands') {
    await parkOn('commands');
    return respond({ commands: [{ name: 'nudge', source: 'command', description: 'Надзиратель bench-harness' }] });
  }
  // Каталог моделей, который можно менять на ходу: FAKE_PI_MODELS_FILE — JSON-список
  // вместо статичного, FAKE_PI_MODELS_DELAY_MS — задержка ответа. Так проверяется,
  // что проба, пережившая сброс кэша, не возвращает в кэш устаревший models.json.
  if (command.type === 'get_available_models') {
    let models = availableModels;
    const file = process.env.FAKE_PI_MODELS_FILE;
    if (file) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(parsed)) models = parsed;
      } catch { /* файл ещё не записан — остаётся статичный список */ }
    }
    // Отметка «список прочитан»: тест меняет файл только после неё, иначе правка
    // обгоняет чтение и доказывает не то, что собиралась.
    const marker = process.env.FAKE_PI_MODELS_READ_MARKER;
    if (marker) fs.writeFileSync(marker, JSON.stringify(models.map(model => model.id)));
    const delay = Number(process.env.FAKE_PI_MODELS_DELAY_MS || 0);
    if (delay > 0) { setTimeout(() => respond({ models }), delay); return; }
    return respond({ models });
  }
  if (command.type === 'get_available_thinking_levels') return respond({ levels: ['off', 'low', 'medium', 'high'] });
  if (command.type === 'set_thinking_level') { thinkingLevel = command.level; return respond(); }
  if (command.type === 'set_model') {
    model = { provider: command.provider, id: command.modelId, contextWindow: 8000, maxTokens: 512 };
    return respond(model);
  }
  if (command.type === 'set_auto_compaction') { automatic = command.enabled; return respond(); }
  if (command.type === 'compact') {
    const result = { tokensBefore: 1100, estimatedTokensAfter: 500, summary: 'Сжатая сводка предыдущего контекста' };
    // Shaped like the real smart-compaction extension (real session 2026-09-30):
    // compaction_start, a start notify, per-stage setStatus ticks with elapsed
    // seconds, then the compaction_end result — the stage the diagnostics panel
    // must show instead of a chat note per chunk.
    send({ type: 'compaction_start', reason: 'manual' });
    send({ type: 'extension_ui_request', id: 'compact-start', method: 'notify', notifyType: 'info',
      message: 'Smart compaction: 1100 tokens; fixture/fixture; summary reasoning=none.' });
    for (const stage of ['chunk 1/2', 'chunk 2/2', 'final merge']) {
      for (const s of [0, 1]) {
        send({ type: 'extension_ui_request', id: `compact-${stage}-${s}`, method: 'setStatus', statusKey: 'smart-compaction',
          statusText: `Smart compaction: ${stage} (${s}s)` });
      }
    }
    send({ type: 'compaction_end', reason: 'manual', result });
    return respond(result);
  }
  if (command.type === 'clear_queue') return respond();
  if (command.type === 'abort') {
    // fault-deaf: Pi that no longer reacts to abort; only killing it helps.
    if (deaf) return;
    clearTimeout(pending);
    if (streaming) { streaming = false; send({ type: 'agent_settled' }); }
    respond();
    // fault-abort-tail: the turn being unwound is not the last word — Pi starts
    // the next one a moment later, after TaskBridge has already written the
    // cancellation. Those frames must not revive the cancelled task.
    if (tailAfterAbort) {
      tailAfterAbort = false;
      setTimeout(() => {
        send({ type: 'agent_start' });
        send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'размышление после STOP' } });
      }, 500);
    }
    return;
  }
  if (['prompt', 'steer', 'follow_up'].includes(command.type)) {
    // Which RPC the text arrived by decides whether a command is queued (Pi refuses)
    // or executed at once: the test reads this log instead of guessing from frames.
    try {
      fs.appendFileSync('pi-deliveries.ndjson', JSON.stringify({ type: command.type, message: command.message }) + '\n');
    } catch { /* a fixture without a writable cwd must not fail the turn */ }
    await parkOn('prompt');
    if (command.message.includes('reject')) return respond({}, false);
    const fault = faultOf(command.message);
    if (fault) return runFault(fault, command, respond);
    // FAKE_PI_ALWAYS_413: каждый ход получает тот же 413 по размеру — так проверяется,
    // что второй отказ после восстановления останавливает цикл (MEDIA-09B).
    // Флаг можно включить файлом уже после первого хода: env сервера меняется только
    // перезапуском, а сценарию 09B нужен успешный первый ход и 413 на всех следующих.
    const flagFile = process.env.FAKE_PI_413_FLAG;
    const always413 = process.env.FAKE_PI_ALWAYS_413 || (flagFile && fs.existsSync(flagFile));
    if (always413) return runFault('provider-incompatible', { ...command, message: `${command.message} body-limit no-tools` }, respond);
    // Replay the anonymized real-Pi compact capture through the actual server
    // event pipeline; the recording path is supplied only by an isolated test.
    if (process.env.FAKE_PI_RECORDING && command.message.includes('[compact-recording]')) {
      const recording = JSON.parse(fs.readFileSync(process.env.FAKE_PI_RECORDING, 'utf8'));
      respond();
      streaming = true;
      turn += 1;
      let index = 0;
      const emit = () => {
        const frame = recording.events[index++].data.pi;
        if (frame.type === 'message_end' && frame.message?.role === 'assistant') persist(frame.message);
        if (frame.type === 'agent_settled') streaming = false;
        send(frame);
        if (index < recording.events.length) pending = setTimeout(emit, 15);
      };
      pending = setTimeout(emit, 50);
      return;
    }
    // A model error BEFORE any output: the «Повторить сообщение» case. No text
    // deltas and no tool call, so the turn is genuinely empty.
    if (command.message.includes('model-error-empty')) {
      respond();
      streaming = true;
      send({ type: 'agent_start' });
      const user = { role: 'user', content: [{ type: 'text', text: command.message }] };
      persist(user);
      send({ type: 'message_start', message: user });
      send({ type: 'message_end', message: user });
      send({ type: 'message_start', message: { role: 'assistant', content: [] } });
      const failed = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Fixture model error', usage: { input: 10, output: 0, totalTokens: 10 } };
      persist(failed);
      send({ type: 'message_end', message: failed });
      streaming = false;
      send({ type: 'agent_end' });
      send({ type: 'agent_settled' });
      return;
    }
    respond();
    streaming = true;
    turn += 1;
    send({ type: 'agent_start' });
    const user = { role: 'user', content: [{ type: 'text', text: command.message }] };
    persist(user);
    send({ type: 'message_start', message: user });
    send({ type: 'message_end', message: user });
    send({ type: 'message_start', message: { role: 'assistant', content: [] } });
    const gate = command.message.includes('approve-me');
    send({ type: 'tool_execution_start', toolCallId: `call-${turn}`, toolName: gate ? 'bash' : 'read', args: gate ? { command: 'rm -rf /tmp/example' } : { path: 'example.txt' } });
    if (gate) {
      approvalGate(`call-${turn}`, 'bash', { command: 'rm -rf /tmp/example' }).then(decision => {
        if (streaming) {
          send({ type: 'tool_execution_end', toolCallId: `call-${turn}`, toolName: 'bash', isError: decision !== 'ALLOW_ONCE', ...(decision !== 'ALLOW_ONCE' ? { errorMessage: `blocked: ${decision}` } : {}) });
          clearTimeout(pending);
          finish(`decision: ${decision}`);
        }
      }).catch(error => {
        if (streaming) {
          send({ type: 'tool_execution_end', toolCallId: `call-${turn}`, toolName: 'bash', isError: true, errorMessage: error.message });
          clearTimeout(pending);
          finish(`approval error: ${error.message}`);
        }
      });
      return;
    }
    // Shaped like real Pi: the update carries the output so far as an object,
    // the end carries the whole result (content parts).
    const readResult = { content: [{ type: 'text', text: 'hello from example.txt' }] };
    send({ type: 'tool_execution_update', toolCallId: `call-${turn}`, toolName: 'read', args: { path: 'example.txt' }, partialResult: readResult });
    send({ type: 'tool_execution_end', toolCallId: `call-${turn}`, toolName: 'read', isError: false, result: readResult });
    // `many-tools`: more successes than the evidence list keeps (bounded at 10),
    // `huge-output`: one result far larger than an excerpt (bounded at 240 chars).
    // Both are keyed off the prompt text like every other fixture mode.
    if (command.message.includes('many-tools')) {
      for (let n = 0; n < 12; n += 1) {
        const id = `bulk-${turn}-${n}`;
        send({ type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: { command: `echo line-${n}` } });
        send({ type: 'tool_execution_end', toolCallId: id, toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: `line-${n}` }] } });
      }
    }
    if (command.message.includes('huge-output')) {
      const id = `huge-${turn}`;
      send({ type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: { command: 'cat big.log' } });
      send({ type: 'tool_execution_end', toolCallId: id, toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'X'.repeat(200000) + '\nTAIL-MARKER\n' }] } });
    }
    // `make-files`: the agent leaves an image and a text file in the workspace,
    // announcing the image through a write tool — the "files from the agent" case.
    if (command.message.includes('make-files')) {
      fs.writeFileSync('result.png', Buffer.from(FIXTURE_PNG, 'base64'));
      fs.writeFileSync('report.txt', 'Отчёт агента\nстрока 2\n');
      send({ type: 'tool_execution_start', toolCallId: `write-${turn}`, toolName: 'write', args: { path: 'result.png' } });
      send({ type: 'tool_execution_end', toolCallId: `write-${turn}`, toolName: 'write', isError: false, result: { content: [{ type: 'text', text: 'wrote result.png' }] } });
    }
    // --- Follow Plan (FP-05) -------------------------------------------------
    // The controller sends an instruction that names the plan file, the planId,
    // the revision, the cycle and the current step (src/application/plan-follower.mjs).
    // This stand-in acts like a model that does the step and then reports a
    // checkpoint: it reads the plan from the workspace, marks the named step done
    // and says COMPLETE only when nothing is left open. Evidence cites the run id
    // the instruction names, which is exactly what the server verifies.
    if (command.message.includes('FOLLOW PLAN')) {
      const checkpoint = followPlanCheckpoint(command.message, `proof-${turn}`);
      if (checkpoint) {
        // The step's proof is a tool call of THIS turn: the production path has to
        // carry its id and outcome from TaskManager all the way to the receipt.
        send({ type: 'tool_execution_start', toolCallId: `proof-${turn}`, toolName: 'bash', args: { command: 'echo fixture-proof' } });
        send({ type: 'tool_execution_end', toolCallId: `proof-${turn}`, toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'fixture-proof' }] } });
        send({ type: 'tool_execution_start', toolCallId: `plan-${turn}`, toolName: 'taskbridge_plan_checkpoint', args: checkpoint });
        // `checkpoint-error`: the tool itself fails, so the claim was never
        // delivered as a result and must not move the cycle (CP-02).
        // `no-checkpoint`: the turn simply has none (CP-07).
        const failed = checkpoint.__failed === true;
        delete checkpoint.__failed;
        send({
          type: 'tool_execution_end', toolCallId: `plan-${turn}`, toolName: 'taskbridge_plan_checkpoint',
          isError: failed,
          ...(failed ? { errorMessage: 'fixture: checkpoint tool failed' } : { result: { content: [{ type: 'text', text: 'Checkpoint received' }] } })
        });
      }
    }
    // A provider that answers with a JSON error envelope (as Pi forwards it
    // verbatim) is a separate case from a plain-text failure.
    const modelError = command.message.includes('model-error-json')
      ? '400: {"code":"422","error_type":"UNSUPPORTED_OPENAI_PARAMS","message":"The following parameters are not supported for this model: tools","param":"tools"}'
      : 'Fixture model error';
    const thinkingText = command.message.includes('think') ? 'Сначала взвешу варианты, потом отвечу.' : null;
    pending = setTimeout(() => {
      finish(command.message.includes('stream-many') ? `Ответ ${turn}: ${'поток '.repeat(20)}` : `Ответ ${turn}`, command.message.includes('model-error'), modelError, thinkingText);
      // Duplicates of the settled frame arrive AFTER the turn ended — the shape a
      // reconnect or a duplicated delivery produces, never a mid-turn event.
      if (planDoubleSettle) {
        setTimeout(() => {
          send({ type: 'agent_settled' });
          send({ type: 'agent_settled' });
        }, 100);
      }
    }, command.message.includes('slow') || planSlow ? 10000 : 80);
  }
});
