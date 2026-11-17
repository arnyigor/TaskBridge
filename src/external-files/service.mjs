import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isPrivatePath, contentType } from '../files.mjs';
import { normalizeExternalReadProject, externalReadRevision, externalProjectIdentity } from './config.mjs';
import { windowsRead, externalError as fail } from './windows-reader.mjs';
import { verifyExternalImage } from './image-policy.mjs';

const LIMIT = 2 * 1024 * 1024;
const PERMISSIONS = ['browse', 'preview', 'attach-file', 'agent-read', 'model-transfer'];
const fields = { browse: 'canBrowse', preview: 'canPreview', 'attach-file': 'canAttach', 'agent-read': 'agentCanRead', 'model-transfer': 'allowModelTransfer' };
const commandPattern = /^[a-zA-Z0-9_-]{8,128}$/;
const image = name => /\.(?:png|jpe?g|webp)$/i.test(name);

export function relativeExternalPath(value = '', allowEmpty = true) {
  if (typeof value !== 'string' || value.length > 2048 || (!allowEmpty && !value)) throw fail('INPUT_INVALID');
  if (!value && allowEmpty) return '';
  const parts = value.split('/');
  if (parts.length > 32 || parts.some(part => !part || part.startsWith('.') || /[\\:\x00-\x1f<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || isPrivatePath(value)) throw fail();
  return value;
}

/** A single atomic journal contains grants, requests, idempotency and audit. */
export class ExternalFilesService {
  constructor({ manager, dataRoot, reader = windowsRead }) {
    this.manager = manager;
    this.file = path.join(dataRoot, 'external-read.json');
    this.reader = reader;
    this.state = { projects: {}, requests: [], commands: [], audit: [] };
    this.tail = Promise.resolve();
    this.manager.uploads.externalAuthorization = binding => {
      const project = this.project(binding.projectId);
      if (!binding.rootId || binding.registrationKey !== externalProjectIdentity(project)) throw fail();
      this.checkRevision(project, binding.revision);
      const root = this.root(binding.projectId, binding.rootId, 'attach-file');
      if (!root.allowModelTransfer) throw fail();
    };
  }
  async init() {
    try { this.state = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!this.state || !Array.isArray(this.state.requests) || !Array.isArray(this.state.commands) || !Array.isArray(this.state.audit) || !this.state.projects || typeof this.state.projects !== 'object') throw fail('INPUT_INVALID');
    for (const [id, project] of this.manager.projects) {
      const record = Object.hasOwn(this.state.projects, id) ? this.state.projects[id] : null;
      const stored = record?.registrationKey === externalProjectIdentity(project) ? record : {};
      const normalized = await normalizeExternalReadProject({ ...project, ...stored, id }, { allowMissing: true });
      this.manager.projects.set(id, normalized);
    }
  }
  project(id) {
    const project = this.manager.projects.get(id);
    if (!project) throw fail('NOT_FOUND');
    return project;
  }
  async transaction(action) {
    const run = this.tail.then(async () => {
      const next = structuredClone(this.state);
      const result = await action(next);
      const temp = `${this.file}.${crypto.randomUUID()}.tmp`;
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      try {
        await fs.writeFile(temp, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
        await fs.rename(temp, this.file);
      } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
      this.state = next;
      for (const [id, settings] of Object.entries(next.projects)) {
        const project = this.manager.projects.get(id);
        if (project && settings.registrationKey === externalProjectIdentity(project)) this.manager.projects.set(id, { ...project, ...settings });
      }
      return result;
    });
    this.tail = run.catch(() => {});
    return run;
  }
  taskProject(taskId) {
    const task = this.manager.getTask(taskId);
    if (!task?.projectId) throw fail('NOT_FOUND');
    const project = this.project(task.projectId);
    const legacyKey = !project.registrationId && task.sourcePath ? externalProjectIdentity({ path: task.sourcePath }) : null;
    if ((task.externalReadProjectKey || legacyKey) !== externalProjectIdentity(project)) throw fail();
    return project;
  }
  checkRevision(project, revision) {
    if (externalReadRevision(project) !== revision) throw fail('REVISION_CONFLICT');
  }
  root(projectId, rootId, permission) {
    const project = this.project(projectId);
    const root = project.externalReadDirectories?.find(root => root.id === rootId);
    if (!root?.enabled || root.revoked || root[fields[permission]] !== true) throw fail();
    return root;
  }
  async available(root) {
    try {
      const real = await fs.realpath(root.path);
      return real.toLowerCase() === root.path.toLowerCase() && (await fs.stat(real)).isDirectory();
    } catch { return false; }
  }
  async roots(projectId) {
    const project = this.project(projectId);
    return Promise.all((project.externalReadDirectories || []).map(async root => ({
      id: root.id, name: path.basename(root.path), available: await this.available(root),
      enabled: root.enabled, revoked: root.revoked, canBrowse: root.enabled && root.canBrowse,
      canPreview: root.enabled && root.canPreview, canAttach: root.enabled && root.canAttach,
      agentCanRead: root.enabled && root.agentCanRead, allowModelTransfer: root.allowModelTransfer,
    })));
  }
  requests(projectId, local = false) {
    this.project(projectId);
    return this.state.requests.filter(request => request.projectId === projectId && request.registrationKey === externalProjectIdentity(this.project(projectId))).map(request => ({ ...request,
      status: request.status === 'PENDING' && Date.parse(request.expiresAt) <= Date.now() ? 'EXPIRED' : request.status,
      requestedPath: local ? request.requestedPath : null,
    }));
  }
  async settings(projectId, local = false) {
    const project = this.project(projectId);
    return { revision: externalReadRevision(project), localOperator: local, roots: await this.roots(projectId), requests: this.requests(projectId, local) };
  }
  audit(state, record) {
    state.audit.push({ at: new Date().toISOString(), ...record });
    state.audit = state.audit.slice(-1000);
  }
  async operate(projectId, rootId, requested, permission, operation, options) {
    try { return await this.#operate(projectId, rootId, requested, permission, operation, options); }
    catch (error) {
      const safeRootId = typeof rootId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(rootId) ? rootId : null;
      await this.transaction(state => this.audit(state, { projectId, rootId: safeRootId, operation: permission, outcome: 'denied', code: error.code || 'FILE_FORBIDDEN' }));
      throw fail(error.code || 'FILE_FORBIDDEN');
    }
  }
  async #operate(projectId, rootId, requested, permission, operation, { cursor = null, signal } = {}) {
    const relative = relativeExternalPath(requested, operation === 'list');
    const root = this.root(projectId, rootId, permission);
    if (['agent-read', 'attach-file'].includes(permission) && !root.allowModelTransfer) throw fail();
    const fingerprint = JSON.stringify(root);
    const current = () => {
      if (JSON.stringify(this.root(projectId, rootId, permission)) !== fingerprint) throw fail();
    };
    if (operation === 'read' && !root.extensions.includes(path.extname(relative).toLowerCase())) throw fail();
    const offset = cursor === null ? 0 : Number(cursor);
    if (!Number.isInteger(offset) || offset < 0 || offset > 5000 || (cursor !== null && !/^\d{1,4}$/.test(String(cursor)))) throw fail('INPUT_INVALID');
    const result = await this.reader({ root: root.path, path: relative, operation, maxBytes: LIMIT, offset, limit: 100 }, { signal });
    current();
    if (operation === 'list') {
      await this.transaction(state => this.audit(state, { projectId, rootId, operation: permission, outcome: 'allowed', bytes: 0 }));
      current();
      const entries = (result.entries || []).filter(entry => {
        try { relativeExternalPath(entry.name, false); } catch { return false; }
        return entry.type === 'directory' || root.extensions.includes(path.extname(entry.name).toLowerCase());
      }).map(entry => ({ ...entry, path: relative ? `${relative}/${entry.name}` : entry.name,
        mimeType: entry.type === 'file' ? contentType(entry.name) : null,
        previewAvailable: root.canPreview && entry.type === 'file' && entry.size <= LIMIT,
      }));
      return { rootId, path: relative, parent: relative ? relative.split('/').slice(0, -1).join('/') : null, entries, nextCursor: result.nextCursor == null ? null : String(result.nextCursor), truncated: result.truncated === true };
    }
    const bytes = Buffer.from(result.base64, 'base64');
    if (bytes.length !== result.size || bytes.length > LIMIT) throw fail('BODY_TOO_LARGE');
    const mimeType = contentType(relative);
    if (image(relative)) verifyExternalImage(bytes, relative);
    else if (bytes.includes(0)) throw fail();
    await this.transaction(state => this.audit(state, { projectId, rootId, operation: permission, outcome: 'allowed', bytes: bytes.length }));
    current();
    return { bytes, mimeType, name: path.posix.basename(relative), image: image(relative) };
  }
  browse(projectId, rootId, relative = '', options) { return this.operate(projectId, rootId, relative, 'browse', 'list', options); }
  preview(projectId, rootId, relative, options) { return this.operate(projectId, rootId, relative, 'preview', 'read', options); }
  async agent(projectId, rootId, relative, operation, options) {
    return this.operate(projectId, rootId, relative, 'agent-read', operation, options);
  }
  command(state, actor, commandId, payload) {
    if (typeof actor !== 'string' || !actor || !commandPattern.test(commandId || '')) throw fail('INPUT_INVALID');
    const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const found = state.commands.find(item => item.actor === actor && item.commandId === commandId);
    if (found && found.hash !== hash) throw fail('INPUT_INVALID');
    return { found, hash };
  }
  async request(projectId, body, actor) {
    return this.transaction(state => {
      const { found, hash } = this.command(state, actor, body.commandId, { ...body, projectId, registrationKey: externalProjectIdentity(this.project(projectId)), operation: 'request' });
      if (found) return state.requests.find(request => request.id === found.requestId);
      this.checkRevision(this.project(projectId), body.expectedRevision);
      const permissions = body.permissions;
      if (!Array.isArray(permissions) || !permissions.length || permissions.length > PERMISSIONS.length || permissions.some(permission => !PERMISSIONS.includes(permission))) throw fail('INPUT_INVALID');
      if (typeof body.path !== 'string' || !body.path.trim() || body.path.length > 2048 || /[\x00-\x1f]/.test(body.path)) throw fail('INPUT_INVALID');
      const now = Date.now();
      if (state.requests.filter(request => request.actor === actor && Date.parse(request.createdAt) > now - 60000).length >= 5 || state.requests.length >= 1000) throw fail();
      const request = { id: crypto.randomUUID(), projectId, registrationKey: externalProjectIdentity(this.project(projectId)), actor, requestedPath: body.path, requestedPermissions: [...new Set(permissions)], status: 'PENDING', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString() };
      state.requests.push(request);
      state.commands.push({ actor, commandId: body.commandId, hash, requestId: request.id });
      state.commands = state.commands.slice(-1000);
      this.audit(state, { projectId, operation: 'request', requestId: request.id, actor });
      return request;
    });
  }
  async decision(projectId, requestId, body, actor) {
    return this.transaction(async state => {
      const { found, hash } = this.command(state, actor, body.commandId, { ...body, projectId, requestId, registrationKey: externalProjectIdentity(this.project(projectId)), operation: 'decision' });
      if (found) return state.requests.find(request => request.id === requestId);
      const project = this.project(projectId);
      this.checkRevision(project, body.expectedRevision);
      const request = state.requests.find(request => request.id === requestId && request.projectId === projectId && request.registrationKey === externalProjectIdentity(project));
      if (!request || request.status !== 'PENDING' || Date.parse(request.expiresAt) <= Date.now()) throw fail('NOT_FOUND');
      if (!['APPROVED', 'DENIED'].includes(body.decision)) throw fail('INPUT_INVALID');
      if (body.decision === 'APPROVED') {
        // The operator supplies the actual path; never approve the remote string blindly.
        const root = { id: `root-${request.id}`, path: body.path, enabled: true, agentCanRead: false };
        for (const permission of request.requestedPermissions) root[fields[permission]] = true;
        const normalized = await normalizeExternalReadProject({ ...project, externalReadDirectories: [...(project.externalReadDirectories || []), root] });
        state.projects = { ...state.projects, [projectId]: { registrationKey: externalProjectIdentity(project), externalReadDirectories: normalized.externalReadDirectories, externalReadRevision: externalReadRevision(project) + 1 } };
      }
      request.status = body.decision;
      state.commands.push({ actor, commandId: body.commandId, hash, requestId });
      state.commands = state.commands.slice(-1000);
      this.audit(state, { projectId, operation: 'decision', requestId, actor, outcome: body.decision });
      return request;
    });
  }
  async search(projectId, rootId, query) {
    if (typeof query !== 'string' || query.length < 1 || query.length > 80 || /[\\/\\\\\x00-\x1f]/.test(query)) throw fail('INPUT_INVALID');
    this.root(projectId, rootId, 'browse');
    const queue = [{ path: '', depth: 0 }];
    const entries = [];
    const started = Date.now();
    let checked = 0;
    let truncated = false;
    while (queue.length && checked < 12 && Date.now() - started < 10000 && entries.length < 100) {
      const current = queue.shift();
      const result = await this.browse(projectId, rootId, current.path);
      checked++;
      for (const entry of result.entries) {
        if (entry.name.toLowerCase().includes(query.toLowerCase())) entries.push(entry);
        if (entry.type === 'directory') {
          if (current.depth < 2 && queue.length < 32) queue.push({ path: entry.path, depth: current.depth + 1 });
          else truncated = true;
        }
      }
      if (result.nextCursor || result.truncated) return { entries: entries.slice(0, 100), checkedDirectories: checked, truncated: true };
    }
    return { entries: entries.slice(0, 100), checkedDirectories: checked, truncated: truncated || queue.length > 0 || entries.length >= 100 };
  }
  async prepare(taskId, body, actor) {
    const project = this.taskProject(taskId);
    const projectId = project.id;
    const root = this.root(projectId, body.rootId, 'attach-file');
    if (!root.allowModelTransfer) throw fail();
    const revision = externalReadRevision(this.project(projectId));
    this.checkRevision(this.project(projectId), body.expectedRevision);
    const existing = this.command(this.state, actor, body.commandId, { ...body, taskId, operation: 'attachment' });
    if (existing.found) return existing.found.result;
    const snapshot = await this.operate(projectId, body.rootId, body.path, 'attach-file', 'read');
    return this.transaction(async state => {
      const { found, hash } = this.command(state, actor, body.commandId, { ...body, taskId, operation: 'attachment' });
      if (found) return found.result;
      this.checkRevision(this.project(projectId), revision);
      this.root(projectId, body.rootId, 'attach-file');
      const result = await this.manager.uploads.stageSnapshot(snapshot, { projectId, taskId, actor, rootId: body.rootId, registrationKey: externalProjectIdentity(project), revision, expiresAt: Date.now() + 3600000 });
      state.commands.push({ actor, commandId: body.commandId, hash, result });
      state.commands = state.commands.slice(-1000);
      this.audit(state, { projectId, rootId: body.rootId, operation: 'attachment', actor, bytes: snapshot.bytes.length });
      return result;
    });
  }
  revoke(projectId, rootId, body, actor) {
    return this.toggle(projectId, rootId, { ...body, enabled: false }, actor, true);
  }
  async toggle(projectId, rootId, body, actor, permanent = false) {
    return this.transaction(state => {
      const { found, hash } = this.command(state, actor, body.commandId, { ...body, projectId, rootId, operation: permanent ? 'revoke' : 'toggle' });
      if (found) return;
      const project = this.project(projectId);
      this.checkRevision(project, body.expectedRevision);
      if (typeof body.enabled !== 'boolean') throw fail('INPUT_INVALID');
      const roots = structuredClone(project.externalReadDirectories || []);
      const root = roots.find(root => root.id === rootId);
      if (!root) throw fail('NOT_FOUND');
      if (root.revoked && body.enabled) throw fail();
      root.enabled = body.enabled;
      if (permanent) root.revoked = true;
      state.projects = { ...state.projects, [projectId]: { registrationKey: externalProjectIdentity(project), externalReadDirectories: roots, externalReadRevision: externalReadRevision(project) + 1 } };
      state.commands.push({ actor, commandId: body.commandId, hash });
      state.commands = state.commands.slice(-1000);
      this.audit(state, { projectId, rootId, operation: permanent ? 'revoke' : 'toggle', actor, enabled: root.enabled });
    });
  }
}
