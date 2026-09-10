import { handler, json, method, readJson } from '../../lib/http.mjs';
import { requireMachine } from '../../lib/auth.mjs';
import { acknowledge } from '../../lib/queue.mjs';
import { commandTopic, validName } from '../../lib/protocol.mjs';

export default handler(async (req, res) => {
  method(req, ['POST']);
  requireMachine(req);
  const body = await readJson(req, 16 * 1024);
  const machineId = validName(body.machineId, 'machineId');
  if (process.env.TASKBRIDGE_MACHINE_ID && machineId !== process.env.TASKBRIDGE_MACHINE_ID) throw Object.assign(new Error('Wrong machineId'), { status: 403 });
  if (typeof body.receiptHandle !== 'string' || !body.receiptHandle) throw Object.assign(new Error('Invalid receipt handle'), { status: 400 });
  await acknowledge(req, commandTopic(machineId), `pc_${machineId}`, body.receiptHandle);
  json(res, 200, { ok: true });
});
