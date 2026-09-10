import { handler, json, method } from '../lib/http.mjs';
import { requireWeb } from '../lib/auth.mjs';
import { receive } from '../lib/queue.mjs';
import { consumerName, taskTopic, validName } from '../lib/protocol.mjs';

export default handler(async (req, res) => {
  method(req, ['GET']);
  requireWeb(req);
  const url = new URL(req.url, 'https://taskbridge.invalid');
  const taskId = validName(url.searchParams.get('taskId'), 'taskId');
  const viewer = consumerName(url.searchParams.get('viewerId'));
  const messages = await receive(req, taskTopic(taskId), viewer);
  json(res, 200, { messages: messages.map(item => ({ receiptHandle: item.receiptHandle, event: item.value.event })) });
});
