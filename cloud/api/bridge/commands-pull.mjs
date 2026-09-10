import { handler, json, method, readJson } from '../../lib/http.mjs';
import { requireMachine } from '../../lib/auth.mjs';
import { receive } from '../../lib/queue.mjs';
import { commandTopic, validName } from '../../lib/protocol.mjs';

export default handler(async (req, res) => {
  method(req, ['POST']);
  requireMachine(req);
  const body = await readJson(req, 16 * 1024);
  const machineId = validName(body.machineId, 'machineId');
  if (process.env.TASKBRIDGE_MACHINE_ID && machineId !== process.env.TASKBRIDGE_MACHINE_ID) throw Object.assign(new Error('Wrong machineId'), { status: 403 });
  const messages = await receive(req, commandTopic(machineId), `pc_${machineId}`, 1, 1);
  json(res, 200, { messages: messages.map(item => ({ receiptHandle: item.receiptHandle, deliveryCount: item.deliveryCount, command: item.value })) });
});
