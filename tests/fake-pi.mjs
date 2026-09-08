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
let turn = messages.filter(x => x.role === 'assistant').length;
const state = () => ({ sessionFile, messageCount: messages.length, isStreaming: streaming, isCompacting: false, autoCompactionEnabled: automatic, model: { id: 'fixture', contextWindow: 65536, maxTokens: 1024 } });
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
    send({ type: 'tool_execution_start', toolCallId: `call-${turn}`, toolName: 'read', args: { path: 'example.txt' } });
    send({ type: 'tool_execution_end', toolCallId: `call-${turn}`, toolName: 'read', isError: false });
    pending = setTimeout(() => finish(`Ответ ${turn}`, command.message.includes('model-error')), command.message.includes('slow') ? 10000 : 80);
  }
});
