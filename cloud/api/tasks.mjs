import crypto from 'node:crypto';
import { handler, json, method, readJson } from '../lib/http.mjs';
import { requireWeb } from '../lib/auth.mjs';
import { send, receive } from '../lib/queue.mjs';
import { COMMANDS, commandTopic, consumerName, indexTopic, validName } from '../lib/protocol.mjs';

export default handler(async (req, res) => {
  method(req, ['GET', 'POST']);
  requireWeb(req);
  if (req.method === 'GET') {
    const url = new URL(req.url, 'https://taskbridge.invalid');
    const viewer = consumerName(url.searchParams.get('viewerId'));
    const messages = await receive(req, indexTopic(), viewer);
    return json(res, 200, { messages: messages.map(item => ({ receiptHandle: item.receiptHandle, event: item.value.event })) });
  }
  const body = await readJson(req);
  const machineId = validName(body.machineId, 'machineId');
  const type = String(body.type || 'START_TASK');
  if (!COMMANDS.has(type)) throw Object.assign(new Error('Invalid command type'), { status: 400 });
  const taskId = type === 'START_TASK' ? validName(body.taskId || crypto.randomUUID().replaceAll('-', ''), 'taskId')
    : (body.taskId ? validName(body.taskId, 'taskId') : undefined);
  if (!taskId && !['SYNC_STATE'].includes(type)) throw Object.assign(new Error(`${type} requires taskId`), { status: 400 });
  const input = body.payload && typeof body.payload === 'object' ? body.payload : {};
  let payload = {};
  if (type === 'START_TASK') {
    if (typeof input.projectId !== 'string' || input.projectId.length > 120 || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 8000) {
      throw Object.assign(new Error('START_TASK requires projectId and a prompt up to 8000 characters'), { status: 400 });
    }
    payload = { projectId: input.projectId, prompt: input.prompt };
  } else if (type === 'FOLLOW_UP') {
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 8000 || !['auto', 'prompt', 'steer', 'follow_up'].includes(input.mode || 'auto')) {
      throw Object.assign(new Error('Invalid FOLLOW_UP payload'), { status: 400 });
    }
    payload = { text: input.text, mode: input.mode || 'auto' };
  } else if (type === 'COMPACT') {
    if (typeof (input.instructions || '') !== 'string' || (input.instructions || '').length > 8000) throw Object.assign(new Error('Invalid COMPACT payload'), { status: 400 });
    payload = { instructions: input.instructions || '' };
  }
  const command = { id: `cmd_${crypto.randomUUID().replaceAll('-', '')}`, type, taskId, payload, createdAt: new Date().toISOString() };
  await send(req, commandTopic(machineId), command, command.id);
  json(res, 202, { commandId: command.id, taskId });
});
