import { CloudError, errorBody } from './errors.mjs';
import { taskId as newTaskId, commandId as newCommandId, approvalId as newApprovalId } from './ids.mjs';
import { compareCommands } from '../../src/domain/cloud-command.mjs';
import { isTerminalState, isTaskState } from '../../src/domain/task-event.mjs';

// The whole cloud API surface (§14, §17, §43, §44, §92). Framework-free so the
// same code runs behind a Vercel function, a Node server and the tests.

const USER_COMMAND_TYPES = new Set(['ABORT_TASK', 'FOLLOW_UP', 'COMPACT', 'SET_MODEL', 'SET_THINKING', 'APPROVAL_RESPONSE']);

// Cloud-side view of a task is a *replica*; the machine is the authority (§71).
const TERMINAL_EVENT_STATE = {
  task_finished: 'COMPLETED',
  task_failed: 'FAILED',
  task_aborted: 'ABORTED'
};

function nowIso(now) { return new Date(now()).toISOString(); }

function heartbeatFreshness(machine, nowMs, offlineAfterMs) {
  if (!machine) return 'OFFLINE';
  if (machine.status === 'ERROR') return 'ERROR';
  const last = Date.parse(machine.lastHeartbeatAt || 0);
  if (!Number.isFinite(last) || nowMs - last > offlineAfterMs) return 'OFFLINE';
  return machine.status === 'BUSY' ? 'BUSY' : 'ONLINE';
}

export function createRouter({ store, auth, now = () => Date.now(), offlineAfterMs = 60000, logger = null, protocolVersion = 1, retention = { taskDays: 90, eventDays: 30 } }) {
  const iso = () => nowIso(now);

  async function enqueue(machineId, type, taskId, payload = {}) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const seq = await store.nextCommandSeq(machineId);
      const command = {
        id: newCommandId(),
        // The machine envelope uses commandId (§15); the store key is `id`.
        commandId: null,
        machineId,
        taskId: taskId ?? null,
        seq,
        type,
        payload,
        status: 'PENDING',
        createdAt: iso(),
        acknowledgedAt: null
      };
      command.commandId = command.id;
      try {
        return await store.enqueueCommand(command);
      } catch (error) {
        // UNIQUE(machine_id, seq) collision: another request allocated the same
        // cursor. Recompute and retry; ids are unique so the retry is safe.
        if (attempt === 4) throw error;
      }
    }
    throw new CloudError('INTERNAL_ERROR', 'Could not allocate a command sequence');
  }

  async function loadTaskForUser(user, id) {
    const task = await store.getTask(id);
    if (!task) throw new CloudError('TASK_NOT_FOUND', `Unknown task ${id}`);
    return auth.assertUserOwns(user, task, 'task');
  }

  async function machineView(machineId, ownerId) {
    const machine = await store.getMachine(machineId);
    if (!machine) throw new CloudError('MACHINE_NOT_FOUND', `Unknown machine ${machineId}`);
    if (ownerId && machine.ownerId && machine.ownerId !== ownerId) throw new CloudError('FORBIDDEN', 'Not allowed to access this machine');
    const status = heartbeatFreshness(machine, now(), offlineAfterMs);
    return {
      ...machine,
      status,
      lastHeartbeatAt: machine.lastHeartbeatAt ?? null,
      heartbeatAgeMs: machine.lastHeartbeatAt ? Math.max(0, now() - Date.parse(machine.lastHeartbeatAt)) : null
    };
  }

  const routes = [
    // --- health -------------------------------------------------------------
    ['GET', /^\/api\/health$/, async () => ({ status: 200, body: { status: 'ok', protocolVersion, machines: auth.machineCount } })],

    // --- human API ----------------------------------------------------------
    ['GET', /^\/api\/machines$/, async ({ user }) => {
      const machines = await store.listMachines(user.id);
      const out = [];
      for (const machine of machines) out.push(await machineView(machine.id, user.id));
      return { status: 200, body: out };
    }],
    ['GET', /^\/api\/machines\/([^/]+)$/, async ({ user, params }) => ({ status: 200, body: await machineView(params[0], user.id) })],

    ['GET', /^\/api\/tasks$/, async ({ user, query }) => {
      const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 500);
      return { status: 200, body: await store.listTasks(user.id, { limit }) };
    }],

    ['POST', /^\/api\/tasks$/, async ({ user, body }) => {
      const machineId = String(body.machineId || '');
      const projectId = String(body.projectId || '');
      const prompt = String(body.prompt || '').trim();
      if (!machineId) throw new CloudError('INPUT_INVALID', 'machineId is required');
      if (!projectId) throw new CloudError('INPUT_INVALID', 'projectId is required');
      if (!prompt && !(body.files || []).length) throw new CloudError('INPUT_INVALID', 'prompt is required');
      const machine = await machineView(machineId, user.id);
      const id = newTaskId();
      const task = {
        id,
        ownerId: user.id,
        machineId,
        projectId,
        prompt,
        status: 'QUEUED',
        createdAt: iso(),
        startedAt: null,
        finishedAt: null,
        lastEventSeq: 0,
        options: body.options && typeof body.options === 'object' ? body.options : {},
        current: 'Queued',
        errorCode: null,
        error: null
      };
      await store.createTask(task);
      const command = await enqueue(machineId, 'START_TASK', id, { projectId, prompt, options: task.options, files: Array.isArray(body.files) ? body.files : [], uploadToken: body.uploadToken ?? null });
      logger?.('info', { component: 'CloudRouter', event: 'task_created', taskId: id, machineId, machineStatus: machine.status });
      // 202: the request never waits for Pi (§14).
      return { status: 202, body: { taskId: id, status: task.status, machineStatus: machine.status, createdAt: task.createdAt, commandId: command.id } };
    }],

    ['GET', /^\/api\/tasks\/([^/]+)$/, async ({ user, params }) => ({ status: 200, body: await loadTaskForUser(user, params[0]) })],

    ['DELETE', /^\/api\/tasks\/([^/]+)$/, async ({ user, params }) => {
      await loadTaskForUser(user, params[0]);
      await store.deleteTask(params[0]);
      return { status: 200, body: { ok: true } };
    }],

    ['GET', /^\/api\/tasks\/([^/]+)\/events$/, async ({ user, params, query }) => {
      const task = await loadTaskForUser(user, params[0]);
      const after = Number(query.after ?? 0);
      const limit = Math.min(Math.max(Number(query.limit ?? 500), 1), 2000);
      if (!Number.isSafeInteger(after) || after < 0) throw new CloudError('INPUT_INVALID', 'Invalid after cursor');
      const events = await store.listEvents(task.id, { after, limit: limit + 1 });
      const hasMore = events.length > limit;
      const page = hasMore ? events.slice(0, limit) : events;
      return {
        status: 200,
        body: {
          taskId: task.id,
          fromSeq: page.length ? Number(page[0].seq) : after + 1,
          toSeq: page.length ? Number(page.at(-1).seq) : after,
          events: page,
          hasMore
        }
      };
    }],

    ['GET', /^\/api\/tasks\/([^/]+)\/approvals$/, async ({ user, params }) => {
      const task = await loadTaskForUser(user, params[0]);
      return { status: 200, body: await store.listApprovals(task.id) };
    }],

    ['POST', /^\/api\/tasks\/([^/]+)\/commands$/, async ({ user, params, body }) => {
      const task = await loadTaskForUser(user, params[0]);
      const type = String(body.type || '');
      if (!USER_COMMAND_TYPES.has(type)) throw new CloudError('COMMAND_REJECTED', `Unsupported command type: ${type}`);
      if (isTerminalState(task.status) && ['FOLLOW_UP', 'COMPACT', 'ABORT_TASK'].includes(type)) {
        throw new CloudError('TASK_ALREADY_FINISHED', `Task ${task.id} is already ${task.status}`);
      }
      const machine = await machineView(task.machineId, user.id);
      const command = await enqueue(task.machineId, type, task.id, body.payload && typeof body.payload === 'object' ? body.payload : {});
      logger?.('info', { component: 'CloudRouter', event: 'command_queued', taskId: task.id, type, machineStatus: machine.status });
      // Queued even when the machine is offline (§21, §84).
      return { status: 202, body: { commandId: command.id, seq: command.seq, type, status: command.status, machineStatus: machine.status } };
    }],

    // --- machine API --------------------------------------------------------
    ['POST', /^\/api\/bridge\/heartbeat$/, async ({ machine, body }) => {
      const payload = body || {};
      auth.assertMachineScope(machine, String(payload.machineId || machine.id));
      const timestamp = typeof payload.timestamp === 'string' ? payload.timestamp : iso();
      const record = await store.upsertMachine({
        id: machine.id,
        ownerId: machine.ownerId,
        displayName: payload.displayName ?? machine.displayName ?? null,
        status: ['ONLINE', 'BUSY', 'ERROR'].includes(payload.status) ? payload.status : 'ONLINE',
        version: payload.version ?? null,
        protocolVersion: Number(payload.protocolVersion || protocolVersion),
        capabilities: payload.capabilities || {},
        commandCapabilities: payload.commandCapabilities || {},
        activeTaskId: payload.activeTaskId ?? null,
        queuedTasks: Number(payload.queuedTasks || 0),
        lastHeartbeatAt: timestamp
      });
      return { status: 200, body: { ok: true, serverTime: iso(), machine: { id: record.id, status: record.status } } };
    }],

    ['GET', /^\/api\/bridge\/commands$/, async ({ machine, query }) => {
      const after = Number(query.after ?? 0);
      const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);
      if (!Number.isSafeInteger(after) || after < 0) throw new CloudError('INPUT_INVALID', 'Invalid after cursor');
      const commands = await store.listCommands(machine.id, { after, limit });
      return { status: 200, body: { commands, lastSeq: await store.lastCommandSeq(machine.id) } };
    }],

    ['POST', /^\/api\/bridge\/commands\/([^/]+)\/ack$/, async ({ machine, params, body }) => {
      const command = await store.getCommand(params[0]);
      if (!command) throw new CloudError('NOT_FOUND', `Unknown command ${params[0]}`);
      auth.assertMachineScope(machine, command.machineId);
      const status = String(body.status || '');
      if (!['ACCEPTED', 'REJECTED', 'DUPLICATE', 'FAILED'].includes(status)) {
        throw new CloudError('INPUT_INVALID', 'status must be ACCEPTED, REJECTED, DUPLICATE or FAILED');
      }
      const updated = await store.ackCommand(command.id, status, body.detail ?? null, iso());
      return { status: 200, body: { ok: true, commandId: updated.id, status: updated.status } };
    }],

    ['POST', /^\/api\/bridge\/events$/, async ({ machine, body }) => {
      const events = Array.isArray(body.events) ? body.events : [];
      if (!events.length) return { status: 200, body: { inserted: 0, duplicates: 0 } };
      const accepted = [];
      for (const raw of events) {
        if (!raw || typeof raw !== 'object') continue;
        const event = {
          eventId: String(raw.eventId || ''),
          taskId: String(raw.taskId || ''),
          machineId: machine.id,
          seq: Number(raw.seq),
          type: String(raw.type || ''),
          createdAt: String(raw.timestamp || raw.createdAt || iso()),
          payload: raw.payload ?? {},
          timestamp: raw.timestamp ?? null
        };
        if (!event.eventId || !event.taskId || !event.type || !Number.isSafeInteger(event.seq) || event.seq <= 0) continue;
        // A machine may only upload events for itself (§66).
        if (raw.machineId && raw.machineId !== machine.id) throw new CloudError('FORBIDDEN', 'Event machineId does not match credential');
        accepted.push(event);
      }
      const result = await store.insertEvents(accepted);
      // Keep the replica task in sync with durable events (§71).
      for (const event of accepted) {
        const patch = {};
        const state = TERMINAL_EVENT_STATE[event.type]
          || (event.type === 'task_created' ? 'QUEUED' : null)
          || (event.type === 'task_state' && isTaskState(event.payload?.status) ? event.payload.status : null);
        if (state) {
          patch.status = state;
          if (state === 'RUNNING' && !patch.startedAt) patch.startedAt = event.createdAt;
          if (isTerminalState(state)) patch.finishedAt = event.createdAt;
          if (event.type === 'task_failed') { patch.errorCode = event.payload?.errorCode ?? null; patch.error = event.payload?.error ?? null; }
        }
        if (event.payload?.current) patch.current = event.payload.current;
        const currentSeq = await store.lastEventSeq(event.taskId);
        patch.lastEventSeq = Math.max(currentSeq, event.seq);
        const task = await store.getTask(event.taskId);
        if (task) await store.updateTask(event.taskId, patch);
        if (event.type === 'approval_required') {
          await store.createApproval({
            id: event.payload?.approvalId || newApprovalId(),
            taskId: event.taskId,
            status: 'PENDING',
            toolCallId: event.payload?.toolCallId ?? null,
            toolName: event.payload?.toolName ?? null,
            risk: event.payload?.risk ?? null,
            requestPayload: event.payload ?? {},
            decision: null,
            createdAt: event.createdAt,
            resolvedAt: null
          }).catch(() => {});
        }
        if (event.type === 'approval_resolved' && event.payload?.approvalId) {
          await store.resolveApproval(event.payload.approvalId, event.payload.decision === 'DENY' ? 'DENY' : 'ALLOW_ONCE', event.createdAt).catch(() => {});
        }
      }
      return { status: 200, body: result };
    }],

    ['POST', /^\/api\/bridge\/reconcile$/, async ({ machine, body }) => {
      auth.assertMachineScope(machine, String(body.machineId || machine.id));
      const active = Array.isArray(body.activeTasks) ? body.activeTasks : [];
      const activeById = new Map(active.map(item => [String(item.taskId), item]));
      const lastEventSeqByTask = body.lastEventSeqByTask && typeof body.lastEventSeqByTask === 'object' ? body.lastEventSeqByTask : {};
      const actions = [];

      for (const task of await store.listTasks(machine.ownerId, { limit: 500 })) {
        if (task.machineId !== machine.id || isTerminalState(task.status)) continue;
        const local = activeById.get(task.id);
        if (!local) {
          // The machine no longer has this task: it finished while offline, or
          // the process restarted. The local side is authoritative (§71).
          await store.updateTask(task.id, {
            status: 'FAILED',
            errorCode: 'MACHINE_LOST_TASK',
            error: 'The machine no longer has this task (restart or local cleanup).',
            finishedAt: iso(),
            current: 'Failed'
          });
          actions.push({ taskId: task.id, action: 'MARKED_FAILED' });
          continue;
        }
        if (local.status && local.status !== task.status && isTaskState(local.status)) {
          await store.updateTask(task.id, {
            status: local.status,
            finishedAt: isTerminalState(local.status) ? iso() : task.finishedAt,
            current: local.current ?? task.current
          });
          actions.push({ taskId: task.id, action: 'STATUS_SYNCED', status: local.status });
        }
        const localSeq = Number(lastEventSeqByTask[task.id] || 0);
        const cloudSeq = await store.lastEventSeq(task.id);
        if (localSeq > cloudSeq) actions.push({ taskId: task.id, action: 'EVENTS_PENDING', fromSeq: cloudSeq + 1, toSeq: localSeq });
      }

      const pending = (await store.listCommands(machine.id, { after: 0, limit: 200 })).filter(command => command.status === 'PENDING');
      logger?.('info', { component: 'CloudRouter', event: 'reconciled', machineId: machine.id, actions: actions.length, pendingCommands: pending.length });
      return { status: 200, body: { ok: true, serverTime: iso(), actions, pendingCommands: pending.length, commands: pending.sort(compareCommands).slice(0, 50) } };
    }]
  ];

  async function handle(request) {
    const method = String(request.method || 'GET').toUpperCase();
    const path = String(request.path || '/');
    const query = request.query || {};
    const body = request.body || {};
    const rawBody = request.rawBody ?? '';
    const headers = request.headers || {};

    const isMachineRoute = path.startsWith('/api/bridge/');
    const isPublic = path === '/api/health';

    for (const [routeMethod, pattern, handler] of routes) {
      if (routeMethod !== method) continue;
      const match = pattern.exec(path);
      if (!match) continue;
      const params = match.slice(1).map(value => decodeURIComponent(value));
      try {
        if (isPublic) return await handler({ params, query, body, headers });
        if (isMachineRoute) {
          const machine = auth.requireMachine(headers, { method, path, body: rawBody });
          return await handler({ params, query, body, headers, machine });
        }
        const user = auth.requireUser(headers);
        return await handler({ params, query, body, headers, user });
      } catch (error) {
        const { status, body: payload } = errorBody(error);
        if (status >= 500) logger?.('error', { component: 'CloudRouter', event: 'handler_failed', path, code: error?.code || null, message: error?.message });
        return { status, body: payload };
      }
    }
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: `No route for ${method} ${path}`, details: {} } } };
  }

  return { handle, enqueue, retention, protocolVersion };
}
