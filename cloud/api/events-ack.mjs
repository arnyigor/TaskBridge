import { handler, json, method, readJson } from '../lib/http.mjs';
import { requireWeb } from '../lib/auth.mjs';
import { acknowledge } from '../lib/queue.mjs';
import { consumerName, indexTopic, taskTopic, validName } from '../lib/protocol.mjs';

export default handler(async (req, res) => {
  method(req, ['POST']);
  requireWeb(req);
  const body = await readJson(req, 128 * 1024);
  const consumer = consumerName(body.viewerId);
  const topic = body.kind === 'index' ? indexTopic() : taskTopic(validName(body.taskId, 'taskId'));
  if (!Array.isArray(body.receiptHandles) || body.receiptHandles.length > 10 || body.receiptHandles.some(item => typeof item !== 'string' || !item)) {
    throw Object.assign(new Error('Invalid receipt handles'), { status: 400 });
  }
  for (const receipt of body.receiptHandles) await acknowledge(req, topic, consumer, receipt);
  json(res, 200, { ok: true });
});
