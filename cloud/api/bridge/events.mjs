import { handler, json, method, readJson } from '../../lib/http.mjs';
import { requireMachine } from '../../lib/auth.mjs';
import { send } from '../../lib/queue.mjs';
import { indexTopic, taskTopic, validName } from '../../lib/protocol.mjs';

export default handler(async (req, res) => {
  method(req, ['POST']);
  requireMachine(req);
  const body = await readJson(req, 512 * 1024);
  validName(body.machineId, 'machineId');
  if (process.env.TASKBRIDGE_MACHINE_ID && body.machineId !== process.env.TASKBRIDGE_MACHINE_ID) throw Object.assign(new Error('Wrong machineId'), { status: 403 });
  if (!Array.isArray(body.records) || body.records.length > 100) throw Object.assign(new Error('Invalid event batch'), { status: 400 });
  const publish = async record => {
    validName(record.taskId, 'taskId');
    if (typeof record.eventId !== 'string' || !/^[A-Za-z0-9_-]{1,220}$/.test(record.eventId) || !record.event || record.event.taskId !== record.taskId
      || !Number.isSafeInteger(record.event.seq) || record.event.seq < 0 || typeof record.event.type !== 'string') {
      throw Object.assign(new Error('Invalid event record'), { status: 400 });
    }
    await send(req, taskTopic(record.taskId), { machineId: body.machineId, event: record.event }, record.eventId);
    if (record.index) await send(req, indexTopic(), { machineId: body.machineId, event: record.event }, `index_${record.eventId}`);
  };
  // Queue has no batch endpoint; keep the PC-facing upload batched and fan it
  // out with bounded concurrency inside the Vercel function.
  const pending = [...body.records];
  await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => {
    while (pending.length) await publish(pending.shift());
  }));
  json(res, 202, { accepted: body.records.length });
});
