import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { listPiSessions, readPiSession } from './pi-session-index.mjs';

const fail = (message, code = 'INPUT_INVALID') => Object.assign(new Error(message), { code });
const timestamp = value => Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : new Date().toISOString();
const messageText = message => typeof message.content === 'string' ? message.content : (message.content || []).filter(x => x.type === 'text').map(x => x.text || '').join('');
const identity = value => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);

export class NativeSessionService {
  constructor(manager) { this.manager = manager; }

  project(id) {
    const project = this.manager.projects.get(id);
    if (!project) throw fail('Проект не найден.', 'PROJECT_NOT_FOUND');
    return project;
  }

  roots(project) {
    if (project.sessionDir) return [project.sessionDir];
    if (Array.isArray(this.manager.config.pi?.sessionRoots)) return this.manager.config.pi.sessionRoots;
    return [path.join(os.homedir(), '.pi', 'agent', 'sessions'), path.join(this.manager.dataRoot, 'pi-sessions')];
  }

  async existing(candidate) {
    for (const task of this.manager.tasks.values()) {
      if (task.nativeSourceKey === candidate.key) return task.id;
      if (task.piSessionFile) {
        const resolved = await fs.realpath(task.piSessionFile).catch(() => null);
        if (resolved && identity(resolved) === identity(candidate.file)) return task.id;
      }
    }
    return null;
  }

  async list(projectId) {
    const project = this.project(projectId);
    const sessions = await listPiSessions(project, this.roots(project));
    return Promise.all(sessions.map(async ({ file, ...session }) => {
      const existingTaskId = await this.existing({ ...session, file });
      // The raw first message includes TaskBridge's own prompt wrapper
      // ("Work only inside the current working directory...") for sessions
      // it created itself; the task's own clean prompt reads far better.
      const existingTask = existingTaskId ? this.manager.tasks.get(existingTaskId) : null;
      const preview = existingTask ? (existingTask.title || existingTask.prompt) : session.preview;
      return { ...session, preview, existingTaskId };
    }));
  }

  // TaskManager serializes admission so simultaneous browser requests cannot
  // publish two tasks for one source. Import itself never starts Pi or a model.
  async importSession({ projectId, sessionKey, confirmedClosed } = {}) {
    const project = this.project(projectId);
    if (confirmedClosed !== true) throw fail('Закройте эту сессию Pi в терминале и подтвердите это перед продолжением.');
    if (typeof sessionKey !== 'string' || !/^[a-f0-9]{64}$/.test(sessionKey)) throw fail('Недопустимый ключ сессии.');
    const candidates = await listPiSessions(project, this.roots(project));
    const source = candidates.find(item => item.key === sessionKey);
    if (!source) throw fail('Сессия не найдена в разрешённых папках проекта.', 'NOT_FOUND');
    const existingId = await this.existing(source);
    if (existingId) return this.manager.getTask(existingId);
    let native;
    try { native = await readPiSession(source.file, project.path); }
    catch (error) { throw fail(`Не удалось прочитать сессию Pi: ${error.message}`); }
    const messages = native.branchMessages;
    const importedAt = new Date().toISOString();
    const firstUser = messages.find(message => message.role === 'user');
    const task = {
      id: crypto.randomUUID().replaceAll('-', '').slice(0, 12), createdAt: importedAt, updatedAt: importedAt,
      status: 'SUCCEEDED', projectId, prompt: (firstUser && messageText(firstUser)) || source.name || 'Продолжение сессии Pi',
      workspacePath: project.path, sourcePath: project.path, worktree: false,
      nativeHistory: true, nativeSession: true, nativeSourceKey: source.key, piSessionFile: source.file,
      current: 'История Pi импортирована. Можно продолжить разговор.', assistantText: '', thinkingText: '',
      error: null, errorCode: null, verification: [], verificationStatus: 'NOT_CONFIGURED', git: null,
      compaction: { count: 0, last: null }, lastUsage: null, model: null, autoCompactionEnabled: null,
      files: [], attachments: [], outputFiles: []
    };
    const events = [];
    let imageBytes = 0;
    const event = (type, message, data, at = importedAt) => events.push({ at, taskId: task.id, type, message, data });
    const frame = (pi, at) => event('PI_EVENT', pi.type, { pi }, at);
    try {
      await this.manager.store.create(task);
      for (const message of messages) {
        const at = timestamp(message.timestamp);
        if (message.role === 'user') {
          const files = [];
          for (const content of Array.isArray(message.content) ? message.content : []) {
            const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' })[content.mimeType];
            if (content.type !== 'image' || !extension || typeof content.data !== 'string' || content.data.length > 24 * 1024 * 1024) continue;
            const bytes = Buffer.from(content.data, 'base64');
            if (bytes.toString('base64') !== content.data || imageBytes + bytes.length > 16 * 1024 * 1024) continue;
            imageBytes += bytes.length;
            const attachment = { id: crypto.randomUUID(), name: `image-${task.attachments.length + 1}.${extension}`, size: bytes.length,
              mimeType: content.mimeType, direction: 'input', createdAt: at };
            const directory = path.join(this.manager.store.taskDir(task.id), 'files');
            await fs.mkdir(directory, { recursive: true });
            await fs.writeFile(path.join(directory, attachment.id), bytes, { flag: 'wx' });
            files.push(attachment);
            task.attachments.push(attachment);
          }
          event('USER_MESSAGE', messageText(message), { text: messageText(message), files, imported: true }, at);
        }
        if (message.role === 'assistant') {
          frame({ type: 'message_start', message }, at);
          task.assistantText += messageText(message);
          task.thinkingText += (Array.isArray(message.content) ? message.content : []).filter(x => x.type === 'thinking').map(x => x.thinking || '').join('');
          if (message.usage) task.lastUsage = message.usage;
          if (message.model) task.model = { id: message.model, provider: message.provider || null, contextWindow: null, maxTokens: null };
        }
        // Keep original roles and structured blocks for exact event replay.
        frame({ type: 'message_end', message }, at);
        if (message.role === 'assistant') {
          for (const tool of Array.isArray(message.content) ? message.content : []) {
            if (tool.type === 'toolCall') frame({ type: 'tool_execution_start', toolCallId: tool.id, toolName: tool.name, args: tool.arguments || {} }, at);
          }
        } else if (message.role === 'toolResult') {
          frame({ type: 'tool_execution_end', toolCallId: message.toolCallId, toolName: message.toolName, result: message, isError: Boolean(message.isError) }, at);
        } else if (message.role === 'compactionSummary' || message.role === 'branchSummary') {
          event('SYSTEM_NOTE', `${message.role === 'compactionSummary' ? 'Контекст был сжат' : 'Сводка другой ветки'}:\n${message.summary || ''}`, { imported: true }, at);
          if (message.role === 'compactionSummary') { task.compaction.count++; task.compaction.last = { summary: message.summary, tokensBefore: message.tokensBefore }; }
        } else if (message.role === 'custom' && message.display) {
          event('SYSTEM_NOTE', messageText(message), { imported: true, customType: message.customType }, at);
        }
      }
      event('TASK_SUCCEEDED', task.current, { imported: true });
      for (const item of events) await this.manager.store.appendEvent(task.id, item);
      await this.manager.store.save(task);
      this.manager.tasks.set(task.id, task);
      for (const item of events) this.manager.emit('task-event', item);
      return this.manager.getTask(task.id);
    } catch (error) {
      this.manager.tasks.delete(task.id);
      await this.manager.store.remove(task.id);
      throw error;
    }
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true; // Unknown owner is never safe to evict.
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function lockRecord(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw fail('Некорректный файл блокировки Pi.', 'SESSION_BUSY');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function removeOwned(file, token) {
  const current = await lockRecord(file).catch(() => null);
  if (current?.token === token) await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

/** Protects TaskBridge writers only; terminal Pi does not honor this sidecar. */
export async function acquireNativeLease(task) {
  if (!task.nativeSession) return async () => {};
  // Validate immediately before taking the lease; fail instead of rebuilding a
  // missing/mismatched native source from a potentially incomplete chat log.
  await readPiSession(task.piSessionFile, task.workspacePath);
  const lock = `${task.piSessionFile}.taskbridge.lock`;
  const token = crypto.randomUUID();
  const record = { pid: process.pid, host: os.hostname(), token, createdAt: new Date().toISOString() };
  const busy = () => fail('Эта сессия Pi уже открыта другим процессом TaskBridge.', 'SESSION_BUSY');
  async function create() {
    const handle = await fs.open(lock, 'wx');
    try { await handle.writeFile(JSON.stringify(record)); }
    catch (error) { await handle.close(); await fs.unlink(lock).catch(() => {}); throw error; }
    await handle.close();
  }
  try { await create(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Serialize stale-owner recovery. Normal wx creation remains exclusive even
    // if a third contender acquires the file during the brief unlink/create gap.
    const recovery = `${lock}.recovery`;
    let guard;
    try { guard = await fs.open(recovery, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') throw busy(); throw error; }
    try {
      await guard.writeFile(JSON.stringify(record));
      const stale = await lockRecord(lock).catch(() => null);
      if (!stale || (stale.host && stale.host !== os.hostname()) || processAlive(stale.pid)) throw busy();
      await fs.unlink(lock);
      try { await create(); } catch (error) { if (error.code === 'EEXIST') throw busy(); throw error; }
    } finally { await guard.close(); await removeOwned(recovery, token); }
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await removeOwned(lock, token);
  };
}
