import { createEnvelope, parseEnvelope, serializeEnvelope } from './protocol.mjs';

// The machine side of the relay (§ cloud-protocol.md).
//
// The PC dials out to the relay, announces itself with its secret, then:
//   • forwards local task events as EVENT frames (the relay routes them to the
//     clients that attached to that session),
//   • executes COMMAND frames through the existing CommandDispatcher and answers
//     with COMMAND_ACK carrying the same commandId,
//   • answers SYNC{afterSeq} by replaying the events the client missed,
//   • keeps presence alive with PING.
//
// No inbound port is ever opened: everything travels on this outbound socket.
//
// The same socket also carries REQUEST frames from the shared UI: the machine
// replays them against its own local API (fetchImpl to localApiBase) and answers
// with RESPONSE, so the browser keeps one interface while all logic stays here.
// Only what CLOUD_ALLOWED exists for is executed — everything else is denied.

// What a cloud client may ask the machine's API for. It starts deliberately small
// (what the shared screens need today) and grows together with device
// permissions at pairing time.
export const CLOUD_ALLOWED = [
  { method: 'GET', path: '/api/health' },
  { method: 'GET', path: '/api/info' },
  { method: 'GET', path: '/api/tasks' },
  { method: 'POST', path: '/api/tasks' },
  { method: 'GET', path: '/api/tasks/:id' },
  { method: 'GET', path: '/api/tasks/:id/events' },
  { method: 'DELETE', path: '/api/tasks/:id' },
  { method: 'POST', path: '/api/tasks/:id/message' },
  { method: 'POST', path: '/api/tasks/:id/model' },
  { method: 'POST', path: '/api/tasks/:id/thinking' },
  { method: 'POST', path: '/api/tasks/:id/compact' },
  { method: 'POST', path: '/api/tasks/:id/pending/send' },
  { method: 'DELETE', path: '/api/tasks/:id/pending' },
  { method: 'GET', path: '/api/models' },
  { method: 'GET', path: '/api/local' }
];

export function isCloudRequestAllowed(method, path) {
  if (typeof path !== 'string' || !path.startsWith('/api/') || path.includes('..') || path.includes('//')) return false;
  const clean = path.split('?')[0].replace(/\/$/, '');
  return CLOUD_ALLOWED.some(entry => {
    if (entry.method !== method) return false;
    const expected = entry.path.split('/');
    const actual = clean.split('/');
    if (expected.length !== actual.length) return false;
    return expected.every((part, index) => part.startsWith(':') ? actual[index].length > 0 : part === actual[index]);
  });
}

export const CONNECTOR_DEFAULTS = {
  pingIntervalMs: 20_000,
  pongTimeoutMs: 75_000,
  reconnectBaseMs: 500,
  reconnectMaxMs: 30_000,
  maxQueuedFrames: 2_000,
  syncBatch: 200,
  syncMaxBatches: 50,
  requestTimeoutMs: 30_000
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createRelayConnector({
  url,
  machineId,
  machineSecret,
  manager,
  dispatcher,
  store,
  logger = () => {},
  limits = {},
  localApiBase = null,
  fetchImpl = globalThis.fetch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  WebSocketImpl = globalThis.WebSocket
} = {}) {
  const config = { ...CONNECTOR_DEFAULTS, ...limits };
  if (!url) throw Object.assign(new Error('relay url is required'), { code: 'INPUT_INVALID' });
  if (!machineId) throw Object.assign(new Error('machineId is required'), { code: 'INPUT_INVALID' });
  if (!machineSecret) throw Object.assign(new Error('machineSecret is required'), { code: 'INPUT_INVALID' });
  if (typeof WebSocketImpl !== 'function') throw Object.assign(new Error('WebSocket is not available'), { code: 'INPUT_INVALID' });

  let socket = null;
  let status = 'idle';
  let attempts = 0;
  let stopped = true;
  let queued = [];
  let pingTimer = null;
  let reconnectTimer = null;
  let lastPongAt = null;
  const listeners = [];

  const now = () => Date.now();

  function log(level, entry) { logger(level, { component: 'RelayConnector', ...entry }); }

  function clearPing() { if (pingTimer) { clearTimer(pingTimer); pingTimer = null; } }
  function clearReconnect() { if (reconnectTimer) { clearTimer(reconnectTimer); reconnectTimer = null; } }

  // Handshake frames (HELLO) must go out on the open socket, before the link is
  // considered online; everything else queues while offline.
  function sendRaw(envelope) {
    const text = serializeEnvelope(envelope);
    if (socket?.readyState === 1) { socket.send(text); return true; }
    return false;
  }

  function send(envelope) {
    const text = serializeEnvelope(envelope);
    if (status === 'online' && socket?.readyState === 1) { socket.send(text); return true; }
    // Queued in memory: a durable outbox (the branch's cloud-outbox) is the next
    // step for surviving a restart while offline.
    if (queued.length >= config.maxQueuedFrames) {
      queued.shift();
      log('warn', { event: 'frames_dropped', reason: 'queue_full' });
    }
    queued.push(text);
    return false;
  }

  /** A local task event becomes an EVENT frame; the store's per-task seq is the cursor. */
  function publishEvent(event) {
    if (!event?.taskId || !Number.isSafeInteger(event.seq)) return false;
    return send(createEnvelope({
      type: 'EVENT', machineId, sessionId: event.taskId, seq: event.seq, payload: { event }
    }));
  }

  function statusFrame(online) {
    return createEnvelope({ type: 'MACHINE_STATUS', machineId, payload: { online, version: null, sessions: manager?.listTasks?.().length ?? null } });
  }

  function flush() {
    const pending = queued;
    queued = [];
    for (const text of pending) {
      try { socket.send(text); }
      catch { queued.push(text); }
    }
    if (queued.length) log('warn', { event: 'flush_incomplete', remaining: queued.length });
  }

  async function answerCommand(frame) {
    const ack = (status_, payload) => createEnvelope({
      type: 'COMMAND_ACK', machineId, sessionId: frame.sessionId || null,
      commandId: frame.commandId, status: status_, to: frame.from || null, payload
    });
    if (typeof dispatcher?.handle !== 'function') { send(ack('REJECTED', { error: { code: 'NOT_SUPPORTED', message: 'No command dispatcher on this machine' } })); return; }
    const command = {
      commandId: frame.commandId,
      machineId,
      taskId: frame.sessionId || null,
      seq: frame.seq ?? 1,
      type: frame.payload?.type,
      payload: frame.payload?.data ?? {}
    };
    let result;
    try { result = await dispatcher.handle(command); }
    catch (error) { result = { status: 'REJECTED', error: { code: error.code || 'INTERNAL_ERROR', message: error.message } }; }
    const state = { FAILED: 'REJECTED', ERROR: 'REJECTED' }[result?.status] || result?.status || 'REJECTED';
    send(ack(state, { detail: result?.detail ?? null, error: result?.error ?? null, result: result?.result ?? null }));
  }

  // A REQUEST is replayed against this machine's own API: the cloud client gets
  // exactly what a local browser would get, and never more than the allowlist.
  async function answerRequest(frame) {
    const requestId = frame.commandId;
    const method = String(frame.payload?.method || 'GET').toUpperCase();
    const requestPath = String(frame.payload?.path || '');
    const respond = (status, payload) => send(createEnvelope({
      type: 'RESPONSE', machineId, commandId: requestId, status, to: frame.from || null, payload
    }));
    if (!localApiBase || typeof fetchImpl !== 'function') { respond('ERROR', { error: { code: 'LOCAL_API_UNAVAILABLE', message: 'This machine cannot answer API requests' } }); return; }
    if (!isCloudRequestAllowed(method, requestPath)) {
      log('warn', { event: 'cloud_request_denied', method, path: requestPath });
      respond('DENIED', { error: { code: 'CLOUD_PATH_DENIED', message: `${method} ${requestPath} is not available to a cloud client` } });
      return;
    }
    try {
      const response = await fetchImpl(`${localApiBase}${requestPath}`, {
        method,
        ...(frame.payload?.body === undefined || frame.payload?.body === null
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(frame.payload.body) }),
        signal: AbortSignal.timeout(config.requestTimeoutMs || 30_000)
      });
      const text = await response.text().catch(() => '');
      respond('OK', { httpStatus: response.status, body: text, contentType: response.headers?.get?.('content-type') || 'application/json' });
    } catch (error) {
      respond('ERROR', { error: { code: error.code || 'LOCAL_API_FAILED', message: error.message } });
    }
  }

  async function answerSync(frame) {
    if (typeof store?.readEvents !== 'function') return;
    const after = Number(frame.payload?.afterSeq ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) return;
    let cursor = after;
    for (let batch = 0; batch < config.syncMaxBatches; batch++) {
      const events = await store.readEvents(frame.sessionId, config.syncBatch, cursor).catch(() => []);
      if (!events.length) break;
      for (const event of events) send(createEnvelope({ type: 'EVENT', machineId, sessionId: frame.sessionId, seq: event.seq, payload: { event, replay: true } }));
      cursor = events.at(-1).seq;
      if (events.length < config.syncBatch) break;
    }
  }

  async function onFrame(frame) {
    if (frame.type === 'AUTH_OK') {
      status = 'online';
      attempts = 0;
      lastPongAt = now();
      log('info', { event: 'relay_online', machineId });
      flush();
      send(statusFrame(true));
      startPing();
      return;
    }
    if (frame.type === 'AUTH_FAIL') {
      status = 'unauthorized';
      log('error', { event: 'relay_unauthorized', code: frame.payload?.code });
      return;
    }
    if (frame.type === 'PONG') { lastPongAt = now(); return; }
    if (frame.type === 'PING') { send(createEnvelope({ type: 'PONG' })); return; }
    if (frame.type === 'PEER_JOINED') {
      // A client joined: it needs the current status now, not at the next change.
      send(statusFrame(true));
      return;
    }
    if (frame.type === 'COMMAND') { await answerCommand(frame); return; }
    if (frame.type === 'REQUEST') { await answerRequest(frame); return; }
    if (frame.type === 'SYNC') { await answerSync(frame); return; }
  }

  function onMessage(data) {
    let frame;
    try { frame = parseEnvelope(typeof data === 'string' ? data : String(data)); }
    catch (error) { log('warn', { event: 'frame_invalid', message: error.message }); return; }
    if (frame.machineId && frame.machineId !== machineId) { log('warn', { event: 'frame_other_machine', machineId: frame.machineId }); return; }
    // Frames are handled in arrival order, so a command cannot overtake the
    // handshake that authorises it.
    chain = chain.then(() => onFrame(frame)).catch(error => log('error', { event: 'frame_failed', message: error.message }));
  }

  let chain = Promise.resolve();

  function startPing() {
    clearPing();
    pingTimer = setTimer(() => {
      if (status !== 'online') return;
      if (lastPongAt && now() - lastPongAt > config.pongTimeoutMs) {
        log('warn', { event: 'relay_pong_timeout' });
        socket?.close(4000, 'pong timeout');
        return;
      }
      send(createEnvelope({ type: 'PING' }));
    }, config.pingIntervalMs);
  }

  function connect() {
    if (stopped) return;
    status = 'connecting';
    attempts += 1;
    const ws = new WebSocketImpl(url);
    socket = ws;
    ws.addEventListener?.('open', () => {
      if (!sendRaw(createEnvelope({ type: 'HELLO', machineId, payload: { role: 'machine', auth: { secret: machineSecret } } }))) {
        log('warn', { event: 'hello_not_sent' });
      }
    });
    ws.addEventListener?.('message', event => onMessage(event.data));
    ws.addEventListener?.('close', () => {
      const wasOnline = status === 'online';
      // "unauthorized" is a terminal state: retrying with a wrong secret would
      // only fill the log. Fix the secret and restart the machine instead.
      if (status !== 'stopped' && status !== 'unauthorized') status = 'offline';
      clearPing();
      if (wasOnline) log('warn', { event: 'relay_disconnected' });
      scheduleReconnect();
    });
    ws.addEventListener?.('error', () => { /* close follows and drives the retry */ });
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer || status === 'unauthorized') return;
    const backoff = Math.min(config.reconnectMaxMs, config.reconnectBaseMs * 2 ** Math.min(attempts, 6));
    // Jitter, so a relay restart does not collect every machine in one instant.
    const delay = Math.round(backoff / 2 + Math.random() * (backoff / 2));
    reconnectTimer = setTimer(() => { reconnectTimer = null; connect(); }, delay);
  }

  function attachManager() {
    if (typeof manager?.on !== 'function') return;
    const handler = event => { publishEvent(event); };
    manager.on('task-event', handler);
    listeners.push(() => manager.off?.('task-event', handler));
  }

  return {
    async start() {
      if (!stopped) return this.status();
      stopped = false;
      // Reset-after-stop support (tests and restarts). Frames queued while the
      // link was down deliberately survive: they are the machine's own events.
      attempts = 0; chain = Promise.resolve(); lastPongAt = null;
      attachManager();
      connect();
      return this.status();
    },
    async stop() {
      stopped = true;
      status = 'stopped';
      clearPing();
      clearReconnect();
      for (const off of listeners.splice(0)) { try { off(); } catch { /* manager already gone */ } }
      try { socket?.close(1000, 'client stopping'); } catch { /* already closed */ }
      socket = null;
    },
    /** Used by tests and by a machine that talks to the relay directly. */
    handleFrame(frame) { return chain.then(() => onFrame(frame)); },
    publishEvent,
    status: () => ({ status, attempts, queued: queued.length, machineId, lastPongAt })
  };
}

// Kept for symmetry with the socket layer: a caller that only wants to wait.
export { sleep };
