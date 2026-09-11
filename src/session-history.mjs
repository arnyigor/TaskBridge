import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { readPiSession } from './pi-session-index.mjs';

// Pi's persisted v3 session keeps message roles, tool results and compaction
// boundaries intact. Use it directly whenever it is available.
export async function restoreSessionFile(task, store, dataRoot) {
  if (task.nativeSession) {
    await readPiSession(task.piSessionFile, task.workspacePath);
    return task.piSessionFile;
  }
  const dir = path.join(dataRoot, 'pi-sessions', task.id);
  await fs.mkdir(dir, { recursive: true });
  const candidates = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(candidates.filter(x => x.isFile() && x.name.endsWith('.jsonl')).map(async x => {
    const file = path.join(dir, x.name);
    return { file, modified: (await fs.stat(file)).mtimeMs };
  }));
  files.sort((a, b) => b.modified - a.modified);
  if (task.piSessionFile) files.sort((a, b) => Number(b.file === task.piSessionFile) - Number(a.file === task.piSessionFile));
  for (const { file } of files) {
    const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean);
    try {
      if (JSON.parse(lines[0]).type === 'session' && lines.some(line => {
        try { return JSON.parse(line).type === 'message'; } catch { return false; }
      })) return file;
    } catch { /* Recover from TaskBridge events below when no Pi session is usable. */ }
  }

  // Scan twice with a bounded-memory iterator: the first pass only decides
  // whether the events already carry Pi user frames.
  let hasPiUsers = false;
  for await (const event of store.iterateEvents(task.id)) {
    if (event.data?.pi?.message?.role === 'user') { hasPiUsers = true; break; }
  }
  const messages = [];
  const userMessage = (text, timestamp) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.parse(timestamp) || Date.now() });
  if (!hasPiUsers) messages.push(userMessage(task.prompt, task.createdAt));
  let pendingUser = null;
  for await (const event of store.iterateEvents(task.id)) {
    const frame = event.data?.pi;
    if (!hasPiUsers && event.type === 'USER_MESSAGE') messages.push(userMessage(event.message, event.at));
    if (frame?.type === 'message_start' && frame.message?.role === 'user') pendingUser = frame.message;
    if (frame?.type === 'message_end' && ['user', 'assistant', 'toolResult'].includes(frame.message?.role)) {
      if (frame.message.role === 'user') pendingUser = null;
      else if (pendingUser) { messages.push(pendingUser); pendingUser = null; }
      messages.push(frame.message);
    }
  }
  if (pendingUser) messages.push(pendingUser);
  if (!messages.some(x => x.role === 'assistant') && task.assistantText) {
    messages.push({ role: 'assistant', content: [{ type: 'text', text: task.assistantText }], api: 'openai-completions', provider: task.model?.provider || 'llama.cpp', model: task.model?.id || '', usage: task.lastUsage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.parse(task.updatedAt) || Date.now() });
  }
  const header = { type: 'session', version: 3, id: crypto.randomUUID(), timestamp: task.createdAt || new Date().toISOString(), cwd: task.workspacePath };
  const entries = [header];
  let parentId = null;
  for (const message of messages) {
    const entry = { type: 'message', id: crypto.randomUUID().slice(0, 8), parentId, timestamp: new Date(message.timestamp || Date.now()).toISOString(), message };
    entries.push(entry);
    parentId = entry.id;
  }
  const file = path.join(dir, `recovered-${crypto.randomUUID()}.jsonl`);
  await fs.writeFile(file, entries.map(x => JSON.stringify(x)).join('\n') + '\n', { flag: 'wx' });
  return file;
}
