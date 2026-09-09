import readline from 'node:readline';
import fs from 'node:fs';
import crypto from 'node:crypto';
const sessionArg = process.argv.indexOf('--session');
const sessionFile = sessionArg >= 0 ? process.argv[sessionArg + 1] : null;
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
let streaming = false;
let pending;
let automatic = true;
let model = { id: 'fixture', contextWindow: 65536, maxTokens: 1024 };
let thinkingLevel = 'medium';
let turn = messages.filter(x => x.role === 'assistant').length;
const state = () => ({ sessionFile, messageCount: messages.length, isStreaming: streaming, isCompacting: false, autoCompactionEnabled: automatic, model, thinkingLevel });

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
function finish(text, fail = false) {
  send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
  const message = { role: 'assistant', content: [{ type: 'text', text }], usage: { input: 1000, output: 100, totalTokens: 1100 }, stopReason: fail ? 'error' : 'stop', ...(fail ? { errorMessage: 'Fixture model error' } : {}) };
  persist(message);
  send({ type: 'message_end', message });
  streaming = false;
  send({ type: 'agent_end' });
  send({ type: 'agent_settled' });
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  const respond = (data = {}, success = true) => send({ type: 'response', id: command.id, command: command.type, success, data, ...(!success ? { error: 'Fixture rejected prompt' } : {}) });
  if (command.type === 'get_state') return respond(state());
  if (command.type === 'set_auto_compaction') { automatic = command.enabled; return respond(); }
  if (command.type === 'set_model') {
    model = { id: command.modelId, provider: command.provider, contextWindow: 65536, maxTokens: 1024 };
    return respond(model);
  }
  if (command.type === 'set_thinking_level') { thinkingLevel = command.level; return respond({ level: command.level }); }
  if (command.type === 'compact') {
    const result = { tokensBefore: 1100, estimatedTokensAfter: 500 };
    send({ type: 'compaction_end', reason: 'manual', result });
    return respond(result);
  }
  if (command.type === 'clear_queue') return respond();
  if (command.type === 'abort') {
    clearTimeout(pending);
    if (streaming) { streaming = false; send({ type: 'agent_settled' }); }
    return respond();
  }
  if (['prompt', 'steer', 'follow_up'].includes(command.type)) {
    if (command.message.includes('reject')) return respond({}, false);
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
    send({ type: 'tool_execution_end', toolCallId: `call-${turn}`, toolName: 'read', isError: false });
    pending = setTimeout(() => finish(`Ответ ${turn}`, command.message.includes('model-error')), command.message.includes('slow') ? 10000 : 80);
  }
});
