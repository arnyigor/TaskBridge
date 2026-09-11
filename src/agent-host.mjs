// AgentHost — the process that owns the agent side (TZ step 5 / P-2).
//
// Single responsibility: hold everything that must survive a gateway restart —
// the TaskManager (which owns the Pi processes), its storage, the always-on
// router, and the instance lock on the data root — and serve that to a gateway
// over the IPC transport. The gateway is only a thin HTTP/SSE client of this
// host; it never touches task state directly.
//
// This module is intentionally reusable: the legacy monolith (server.mjs) can
// keep using the same TaskManager in-process, while a headless host.mjs runs
// this same AgentHost and exposes it over IPC. Nothing here assumes it is the
// only process: the instance lock arbitrates access to the data root.

import fs from 'node:fs';
import path from 'node:path';
import { TaskStore } from './task-store.mjs';
import { TaskManager } from './task-manager.mjs';
import { acquireInstanceLock } from './instance-lock.mjs';
import { HostIpcServer, persistToken } from './ipc.mjs';

// Maps an IPC command name to a callable. `req` is the request handler given to
// the HostIpcServer; it calls `services.manager` / `services.store` behind a
// thin, explicit contract so the gateway does not depend on manager internals.
export function buildDispatcher({ manager, store }) {
  return async (name, args = {}) => {
    const m = manager;
    switch (name) {
      // --- projects / tasks -------------------------------------------------
      case 'listProjects': return m.listProjects();
      case 'registerProject': return m.registerProject(args.project);
      case 'listTasks': return m.listTasks();
      case 'getTask': return m.getTask(args.id);
      case 'createTask': return m.createTask(args.input, { ...(args.options || {}), commandId: args.commandId, clientId: args.clientId });
      case 'renameTask': return m.renameTask(args.id, args.title);
      case 'deleteTask': return m.deleteTask(args.id);

      // --- messaging / lifecycle --------------------------------------------
      case 'message': return m.message(args.id, args.text, args.mode || 'auto', args.files || [], args.uploadToken, { now: args.now === true, queue: args.queue === true, commandId: args.commandId, clientId: args.clientId });
      case 'cancel': return m.cancel(args.id, { commandId: args.commandId, clientId: args.clientId });
      case 'compact': return m.compact(args.id, args.instructions);
      case 'state': return m.state(args.id);
      case 'sendPendingNow': return m.sendPendingNow(args.id);
      case 'dropPending': return m.dropPending(args.id);
      case 'applyTask': return m.applyTask(args.id, { force: args.force === true, commandId: args.commandId, clientId: args.clientId });

      // --- model -----------------------------------------------------------------
      case 'setModel': return m.setModel(args.id, args.provider, args.modelId ?? args.model ?? args.id2);
      case 'setThinking': return m.setThinkingLevel(args.id, args.level);
      case 'listModels': return m.listModels(args.id);
      case 'loading': return { loading: m.local?.loading?.() ?? false };
      case 'localStatus': return m.localStatus ? m.localStatus() : null;

      // --- import / approvals / mcp --------------------------------------------
      case 'importSession': return m.importSession(args.input);
      case 'listApprovals': return m.listApprovals(args.id);
      case 'resolveApproval': return m.resolveApproval(args.id, args.approvalId, args.decision);
      case 'setAutoCompaction': return m.setAutoCompaction(args.id, args.enabled === true);
      case 'cleanupWorktree': return m.cleanupWorktree ? m.cleanupWorktree(args.id) : Promise.reject(Object.assign(new Error('not implemented'), { code: 'NOT_IMPLEMENTED' }));
      case 'mcpStatus': return m.mcpStatus ? m.mcpStatus(args.id) : { providers: [] };

      // --- events (read-only; host is the only SQLite writer) -------------------
      case 'events': return store.readEvents(args.id, args.count, args.after);
      case 'commandStatus': return m.commandStatus(args.commandId);

      default:
        throw Object.assign(new Error(`unknown command: ${name}`), { code: 'NOT_IMPLEMENTED' });
    }
  };
}

// Assembles and owns the agent side. `close()` mirrors the monolith's graceful
// shutdown: it stops the IPC server, the manager (Pi + router) and the store,
// then releases the lock.
export class AgentHost {
  constructor({ config, dataRoot, rootDir, store = null, hostPort = 0, tokenFile = null }) {
    this.config = config;
    this.dataRoot = dataRoot;
    this.rootDir = rootDir;
    this.hostPort = hostPort;
    this.tokenFile = tokenFile || path.join(dataRoot, 'host-ipc.json');
    this.store = store;
    this.lock = null;
    this.manager = null;
    this.ipc = null;
    this.token = null;
  }

  async init() {
    try {
      this.lock = acquireInstanceLock(this.dataRoot);
    } catch (error) {
      throw Object.assign(error, { code: error.code || 'ALREADY_RUNNING' });
    }
    this.store = this.store || new TaskStore(this.dataRoot, {
      synchronous: this.config.server?.sqlite?.synchronous,
      busyTimeoutMs: this.config.server?.sqlite?.busyTimeoutMs,
    });
    this.manager = new TaskManager(this.config, this.dataRoot, this.store);
    this.manager.approvalBaseUrl = `http://127.0.0.1:${Number(this.config.server?.port || 8787)}`;
    this.manager.approvalExtensionPath = path.join(this.rootDir, 'pi-extension', 'taskbridge-approval.js');
    await this.manager.init();
    if (this.manager.localModels.enabled) {
      this.manager.startLocal().catch((error) => console.error(`[AgentHost] router start failed: ${error.message}`));
    }
  }

  async startIpc() {
    this.token = persistToken(this.tokenFile);
    this.ipc = new HostIpcServer({
      port: this.hostPort,
      token: this.token,
      handlers: { request: buildDispatcher({ manager: this.manager, store: this.store }) },
    });
    const addr = await this.ipc.start();
    this.hostPort = addr.port;
    // Forward the agent's live event stream to the gateway, which fans it out
    // to SSE + push. One source of truth for live events.
    this._onTaskEvent = (event) => this.ipc.broadcast('task-event', event);
    this.manager.on('task-event', this._onTaskEvent);
    for (const evt of ['status', 'progress', 'event']) {
      this.manager.localModels?.on(evt, (data) => this.ipc.broadcast('local-'+evt, data));
    }
    return { port: this.hostPort, token: this.token, tokenFile: this.tokenFile };
  }

  async close() {
    if (this.ipc) { try { this.ipc.close(); } catch {} this.ipc = null; }
    if (this._onTaskEvent) { try { this.manager?.off?.('task-event', this._onTaskEvent); } catch {} this._onTaskEvent = null; }
    try { await this.manager?.close(); } catch {}
    try { this.store?.close(); } catch {}
    if (this.lock) { try { this.lock.release(); } catch {} this.lock = null; }
  }
}
