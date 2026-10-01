import readline from 'node:readline';
import fs from 'node:fs';
import crypto from 'node:crypto';
// `pi --version`, as TaskBridge probes it at startup. Overridable so tests can
// play an unsupported Pi.
if (process.argv.includes('--version')) {
  process.stdout.write(`${process.env.FAKE_PI_VERSION || '0.85.1'}\n`);
  process.exit(0);
}
const sessionArg = process.argv.indexOf('--session');
const sessionFile = sessionArg >= 0 ? process.argv[sessionArg + 1] : null;
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
function finish(text, fail = false, errorMessage = 'Fixture model error') {
  // `stream-many` answers are long: one delta per character, so a client can
  // (re)connect in the middle of a stream.
  const parts = text.length > 40 ? [...text] : text.length >= 3 ? [text.slice(0, 1), text.slice(1, 2), text.slice(2)] : [text];
  let index = 0;
  const emit = () => {
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: parts[index] } });
    index += 1;
    if (index < parts.length) { setTimeout(emit, parts.length > 40 ? 8 : 25); return; }
    const message = { role: 'assistant', content: [{ type: 'text', text }], usage: { input: 1000, output: 100, totalTokens: 1100 }, stopReason: fail ? 'error' : 'stop', ...(fail ? { errorMessage } : {}) };
    persist(message);
    send({ type: 'message_end', message });
    streaming = false;
    send({ type: 'agent_end' });
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
//   fault-slow-stream  streams 8 tokens with a 3 s pause in the middle: a local
//                 engine chunking slowly, where the pause IS generation time
let deaf = false;
let tailAfterAbort = false;
function faultOf(message) {
  const match = String(message || '').match(/fault-(queue-crash|crash|garbage|utf8|hang|deaf-stream|abort-tail|deaf|child|notices|slow-stream)/);
  return match ? match[1] : null;
}
function startTurn(message) {
  streaming = true;
  turn += 1;
  send({ type: 'agent_start' });
  const user = { role: 'user', content: [{ type: 'text', text: message }] };
  persist(user);
  send({ type: 'message_start', message: user });
  send({ type: 'message_end', message: user });
  send({ type: 'message_start', message: { role: 'assistant', content: [] } });
  send({ type: 'tool_execution_start', toolCallId: `call-${turn}`, toolName: 'bash', args: { command: 'pytest' } });
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

readline.createInterface({ input: process.stdin }).on('line', line => {
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
  if (command.type === 'get_available_models') return respond({ models: availableModels });
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
    if (command.message.includes('reject')) return respond({}, false);
    const fault = faultOf(command.message);
    if (fault) return runFault(fault, command, respond);
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
    // `make-files`: the agent leaves an image and a text file in the workspace,
    // announcing the image through a write tool — the "files from the agent" case.
    if (command.message.includes('make-files')) {
      fs.writeFileSync('result.png', Buffer.from(FIXTURE_PNG, 'base64'));
      fs.writeFileSync('report.txt', 'Отчёт агента\nстрока 2\n');
      send({ type: 'tool_execution_start', toolCallId: `write-${turn}`, toolName: 'write', args: { path: 'result.png' } });
      send({ type: 'tool_execution_end', toolCallId: `write-${turn}`, toolName: 'write', isError: false, result: { content: [{ type: 'text', text: 'wrote result.png' }] } });
    }
    // A provider that answers with a JSON error envelope (as Pi forwards it
    // verbatim) is a separate case from a plain-text failure.
    const modelError = command.message.includes('model-error-json')
      ? '400: {"code":"422","error_type":"UNSUPPORTED_OPENAI_PARAMS","message":"The following parameters are not supported for this model: tools","param":"tools"}'
      : 'Fixture model error';
    pending = setTimeout(() => finish(command.message.includes('stream-many') ? `Ответ ${turn}: ${'поток '.repeat(20)}` : `Ответ ${turn}`, command.message.includes('model-error'), modelError), command.message.includes('slow') ? 10000 : 80);
  }
});
