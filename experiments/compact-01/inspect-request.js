// Test-only extension for experiments/compact-01: records what actually goes to
// the provider — one JSONL line per request, per message: role, part types and
// text size. No content, no arguments.
//
//   TASKBRIDGE_INSPECT_LOG=<file> pi -e <this file> ...
import fs from 'node:fs';

const textSize = part => {
  if (typeof part?.text === 'string') return part.text.length;
  if (typeof part?.content === 'string') return part.content.length;
  return 0;
};

export default function inspectRequestExtension(pi) {
  const logPath = process.env.TASKBRIDGE_INSPECT_LOG || '';
  if (!logPath) return;
  let requests = 0;
  pi.on('before_provider_request', async (event) => {
    requests += 1;
    const payload = event?.payload || {};
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const record = {
      at: new Date().toISOString(),
      request: requests,
      systemChars: typeof payload.system === 'string' ? payload.system.length : JSON.stringify(payload.system || '').length,
      tools: Array.isArray(payload.tools) ? payload.tools.length : 0,
      toolsChars: Array.isArray(payload.tools) ? JSON.stringify(payload.tools).length : 0,
      messages: messages.map(message => {
        const parts = Array.isArray(message.content) ? message.content : [];
        const isString = typeof message.content === 'string';
        return {
          role: message.role,
          types: isString ? ['string'] : [...new Set(parts.map(part => part?.type).filter(Boolean))],
          chars: isString ? message.content.length : parts.reduce((sum, part) => sum + textSize(part), 0),
        };
      }),
    };
    try { fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8'); } catch { /* experiment only */ }
  });
}
