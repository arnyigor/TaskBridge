// One client interface, two ways to the machine (docs/cloud-ui.md).
//
// The UI must not care whether it runs on the PC (same-origin HTTP + SSE) or on a
// phone (protocol frames through the relay). Both implementations expose:
//
//   kind                          'local' | 'cloud'
//   request(method, path, body)    local HTTP; the cloud transport rejects, so a
//                                  caller can tell "this screen needs the PC"
//   open(sessionId, { after })     subscribe to a session: { close(), synced }
//   command({ sessionId, type, data, timeoutMs })  cloud action with an
//                                 acknowledgement; local transport rejects
//   close()                        release everything
//
// Everything browser-specific (fetch, EventSource, WebSocket) is injected, so
// this module is testable in Node against a real server.

export const TRANSPORT_KINDS = ['local', 'cloud'];

const failure = (code, message) => Object.assign(new Error(message), { code });

/* ------------------------------------------------------------------ local */

export function createLocalTransport({ base = '', fetchImpl = globalThis.fetch, EventSourceImpl = globalThis.EventSource } = {}) {
  if (typeof fetchImpl !== 'function') throw failure('INPUT_INVALID', 'fetch is not available');
  const subscriptions = new Set();

  return {
    kind: 'local',

    async request(method, path, body) {
      const response = await fetchImpl(`${base}${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw failure(payload.code || `HTTP_${response.status}`, payload.error || response.statusText);
      return payload;
    },

    // Same-origin Server-Sent Events, exactly as the local UI has always used.
    open(sessionId, { after = 0, onEvent = () => {}, onStatus = () => {} } = {}) {
      if (typeof EventSourceImpl !== 'function') throw failure('INPUT_INVALID', 'EventSource is not available');
      const query = after ? `?after=${encodeURIComponent(after)}` : '';
      // /stream is the SSE endpoint; /events is the paginated history.
      const source = new EventSourceImpl(`${base}/api/tasks/${encodeURIComponent(sessionId)}/stream${query}`);
      let cursor = after;
      source.onmessage = message => {
        let event;
        try { event = JSON.parse(message.data); } catch { return; }
        if (Number.isSafeInteger(event?.seq)) {
          if (event.seq <= cursor) return;   // the stream may repeat after a reconnect
          cursor = event.seq;
        }
        onEvent(event);
      };
      source.onerror = () => onStatus('reconnecting');
      const handle = {
        synced: false,
        cursor,
        close() { subscriptions.delete(handle); source.close(); }
      };
      subscriptions.add(handle);
      onStatus('open');
      return handle;
    },

    async command() { throw failure('NOT_SUPPORTED', 'The local transport acts through HTTP requests'); },

    async close() {
      for (const handle of [...subscriptions]) handle.close();
    }
  };
}

/* ------------------------------------------------------------------ cloud */

export function createCloudTransport({
  url,
  machineId,
  deviceToken,
  WebSocketImpl = globalThis.WebSocket,
  logger = () => {},
  commandTimeoutMs = 30_000,
  syncTimeoutMs = 30_000,
  reconnectBaseMs = 500,
  reconnectMaxMs = 30_000,
  random = Math.random,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (!url) throw failure('INPUT_INVALID', 'relay url is required');
  if (!machineId) throw failure('INPUT_INVALID', 'machineId is required');
  if (typeof WebSocketImpl !== 'function') throw failure('INPUT_INVALID', 'WebSocket is not available');

  const protocol = { version: 2 };
  let socket = null;
  let status = 'idle';
  let attempts = 0;
  let stopped = true;
  let reconnectTimer = null;
  const pending = new Map();          // commandId -> { resolve, reject, timer }
  const sessions = new Map();         // sessionId -> { onEvent, onStatus, seen:Set, awaitingSync }
  const handlers = { event: [], status: [] };

  const emitStatus = value => { status = value; for (const handler of handlers.status) handler(value); };
  const newEnvelope = (fields) => ({
    v: protocol.version,
    id: globalThis.crypto?.randomUUID?.() || `f-${Date.now()}-${Math.round(random() * 1e6)}`,
    ts: new Date().toISOString(),
    machineId,
    sessionId: null, commandId: null, seq: null, status: null, from: null, to: null, payload: null,
    ...fields
  });

  function send(envelope, { queue = false } = {}) {
    if (socket?.readyState === 1) { socket.send(JSON.stringify(envelope)); return true; }
    if (queue) logger('warn', { event: 'frame_dropped_offline', type: envelope.type });
    return false;
  }

  function settleCommand(commandId, result) {
    const entry = pending.get(commandId);
    if (!entry) return;
    pending.delete(commandId);
    clearTimer(entry.timer);
    if (result.error) entry.reject(failure(result.error.code || 'COMMAND_FAILED', result.error.message || 'Command failed'));
    else entry.resolve(result);
  }

  function deliverEvent(frame) {
    const session = sessions.get(frame.sessionId);
    const event = frame.payload?.event;
    if (!session || !event) return;
    // A replay may overlap the live stream: the seq cursor is the judge.
    const seq = Number(frame.seq);
    if (Number.isSafeInteger(seq)) {
      if (session.seen.has(seq)) return;
      session.seen.add(seq);
    }
    if (session.awaitingSync) { session.awaitingSync = false; session.handle.synced = true; }
    session.onEvent(event);
    for (const handler of handlers.event) handler(event, frame);
  }

  function onMessage(data) {
    let frame;
    try { frame = JSON.parse(data); } catch { return; }
    if (frame.v !== protocol.version) { logger('warn', { event: 'protocol_version', version: frame.v }); return; }
    if (frame.type === 'AUTH_OK') { attempts = 0; emitStatus('online'); return; }
    if (frame.type === 'AUTH_FAIL') { emitStatus('unauthorized'); logger('error', { event: 'relay_auth_failed', payload: frame.payload }); return; }
    if (frame.type === 'MACHINE_STATUS') { for (const session of sessions.values()) session.onStatus?.('machine', frame.payload); return; }
    if (frame.type === 'EVENT') { deliverEvent(frame); return; }
    if (frame.type === 'COMMAND_ACK') {
      if (frame.status === 'ACCEPTED' || frame.status === 'COMPLETED' || frame.status === 'DUPLICATE') settleCommand(frame.commandId, { status: frame.status, ...frame.payload });
      else settleCommand(frame.commandId, { error: frame.payload?.error || { code: frame.status, message: 'Command was not accepted' } });
      return;
    }
    if (frame.type === 'ERROR') logger('warn', { event: 'relay_error', payload: frame.payload });
  }

  function connect() {
    if (stopped) return;
    emitStatus('connecting');
    attempts += 1;
    const ws = new WebSocketImpl(url);
    socket = ws;
    ws.addEventListener?.('open', () => {
      ws.send(JSON.stringify(newEnvelope({ type: 'HELLO', payload: { role: 'client', deviceId: null, auth: { deviceToken } } })));
    });
    ws.addEventListener?.('message', event => onMessage(event.data));
    ws.addEventListener?.('close', () => {
      for (const [commandId, entry] of pending) { clearTimer(entry.timer); entry.reject(failure('RELAY_OFFLINE', 'The relay connection closed')); pending.delete(commandId); }
      if (status !== 'stopped' && status !== 'unauthorized') emitStatus('offline');
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer || status === 'unauthorized') return;
    const backoff = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** Math.min(attempts, 6));
    const delay = Math.round(backoff / 2 + random() * (backoff / 2));
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      connect();
      // Re-attach and re-sync everything that was open before the break.
      for (const [sessionId, session] of sessions) {
        send(newEnvelope({ type: 'ATTACH', sessionId }));
        send(newEnvelope({ type: 'SYNC', sessionId, payload: { afterSeq: session.lastSeq() } }));
      }
    }, delay);
  }

  const transport = {
    kind: 'cloud',

    async request() { throw failure('NOT_SUPPORTED', 'This screen needs the machine: open TaskBridge on the PC'); },

    on(event, handler) { if (handlers[event]) handlers[event].push(handler); },

    async ready(timeoutMs = 10_000) {
      stopped = false;
      if (status === 'idle' || status === 'offline' || status === 'stopped') connect();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (status === 'online') return true;
        if (status === 'unauthorized') throw failure('AUTH_FAILED', 'The relay rejected this device');
        await new Promise(resolve => setTimer(resolve, 20));
      }
      throw failure('RELAY_TIMEOUT', 'The relay did not answer');
    },

    open(sessionId, { after = 0, onEvent = () => {}, onStatus = () => {} } = {}) {
      const seen = new Set();
      const session = {
        onEvent, onStatus, seen, awaitingSync: true,
        lastSeq: () => (seen.size ? Math.max(...seen) : after)
      };
      const handle = {
        synced: false,
        close() {
          sessions.delete(sessionId);
          if (status === 'online') send(newEnvelope({ type: 'DETACH', sessionId }));
        }
      };
      session.handle = handle;
      sessions.set(sessionId, session);
      const last = handle.synced ? session.lastSeq() : after;
      if (status === 'online') {
        send(newEnvelope({ type: 'ATTACH', sessionId }));
        send(newEnvelope({ type: 'SYNC', sessionId, payload: { afterSeq: last } }));
      }
      setTimer(() => { if (session.awaitingSync) { session.awaitingSync = false; handle.synced = true; onStatus('synced-empty'); } }, syncTimeoutMs);
      return handle;
    },

    async command({ sessionId = null, type, data = {}, timeoutMs = commandTimeoutMs } = {}) {
      if (!type) throw failure('INPUT_INVALID', 'command type is required');
      const commandId = globalThis.crypto?.randomUUID?.() || `c-${Date.now()}-${Math.round(random() * 1e6)}`;
      const envelope = newEnvelope({ type: 'COMMAND', sessionId, commandId, seq: 1, payload: { type, data } });
      return new Promise((resolve, reject) => {
        const timer = setTimer(() => { pending.delete(commandId); reject(failure('COMMAND_TIMEOUT', 'The machine did not answer')); }, timeoutMs);
        pending.set(commandId, { resolve, reject, timer });
        if (!send(envelope)) { clearTimer(timer); pending.delete(commandId); reject(failure('RELAY_OFFLINE', 'The relay is not connected')); }
      });
    },

    status: () => status,
    close() {
      stopped = true;
      emitStatus('stopped');
      if (reconnectTimer) { clearTimer(reconnectTimer); reconnectTimer = null; }
      for (const entry of pending.values()) { clearTimer(entry.timer); entry.reject(failure('RELAY_OFFLINE', 'Transport closed')); }
      pending.clear();
      sessions.clear();
      try { socket?.close(1000, 'client closing'); } catch { /* already closed */ }
      socket = null;
    }
  };
  return transport;
}

/* --------------------------------------------------------------- selection */

/**
 * Which transport fits this page: the local one when the page is served by the
 * machine itself (localhost, LAN address, file), the cloud one otherwise.
 */
export function selectTransport({ location = globalThis.location, cloud = null, fetchImpl, EventSourceImpl } = {}) {
  const host = location?.hostname || '';
  const localish = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  if (localish || !cloud) return createLocalTransport({ fetchImpl, EventSourceImpl });
  return createCloudTransport({ machineId: cloud.machineId, deviceToken: cloud.deviceToken, url: cloud.url, ...(cloud.options || {}) });
}
