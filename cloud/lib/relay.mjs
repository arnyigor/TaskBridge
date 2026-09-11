import { createEnvelope, parseEnvelope, serializeEnvelope } from '../../src/cloud/protocol.mjs';

// Cloud relay core (§ cloud-protocol.md).
//
// The relay is a telephone exchange, not a database: it routes frames between a
// machine and the clients that are allowed to talk to it, keeps "who is online"
// with a short TTL and rate-limits devices. It never stores sessions, tasks or
// events, and it never looks inside `payload` — with E2EE on, that is ciphertext.
//
// The transport (WebSocket in production, a stub in tests) supplies connections
// shaped like { send(text), close(code, reason) }. Everything below is pure
// enough to test without a socket.

export const RELAY_DEFAULTS = {
  maxClientsPerMachine: 8,
  maxAttachedSessions: 16,
  maxFramesPerSecond: 40,
  presenceTtlMs: 45_000
};

const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * Presence, cross-instance fan-out and rate limiting for the relay.
 *
 * Production uses a shared store (Upstash Redis over the Vercel Marketplace) so
 * that a machine connected to one instance is reachable from another; the memory
 * implementation below is what runs locally and in tests. See
 * docs/cloud-protocol.md § "Что нужно от релея".
 */
export function createMemoryRelayState({ now = () => Date.now() } = {}) {
  const presence = new Map();
  const rates = new Map();
  return {
    async setPresence(machineId, ttlMs) { presence.set(machineId, now() + ttlMs); },
    async clearPresence(machineId) { presence.delete(machineId); },
    async isPresent(machineId) {
      const expiresAt = presence.get(machineId);
      if (!expiresAt) return false;
      if (expiresAt <= now()) { presence.delete(machineId); return false; }
      return true;
    },
    // One instance: there is nowhere to fan out to.
    async publish() { return { delivered: 0 }; },
    async rateLimit(key, { limit, windowMs }) {
      const cutoff = now() - windowMs;
      const hits = (rates.get(key) || []).filter(at => at > cutoff);
      if (hits.length >= limit) { rates.set(key, hits); return false; }
      hits.push(now());
      rates.set(key, hits);
      return true;
    }
  };
}

export function createRelay({ state = createMemoryRelayState(), logger = () => {}, limits = {} } = {}) {
  const config = { ...RELAY_DEFAULTS, ...limits };
  const machines = new Map();  // machineId -> connection
  const clients = new Map();   // machineId -> Set<connection>
  let connections = 0;

  const send = (connection, envelope) => connection.send(serializeEnvelope(envelope));
  const reject = (connection, code, message, { close = false } = {}) => {
    logger('warn', { event: 'relay_error', code, message });
    try { send(connection, createEnvelope({ type: 'ERROR', payload: { code, message } })); } catch { /* peer already gone */ }
    if (close) connection.close(1008, code);
  };
  const machinePeers = machineId => clients.get(machineId) || new Set();

  function attach(connection) {
    const session = { connection, role: null, machineId: null, deviceId: null, attached: new Set(), closed: false };
    // Rate limiting is per connection, not per role: the HELLO frame arrives
    // before the role is known, and a reconnect must not inherit the old budget.
    const rateKey = `conn:${++connections}`;

    async function hello(frame) {
      if (session.role) return reject(connection, 'ALREADY_HELLO', 'This connection already said HELLO', { close: true });
      const role = frame.payload?.role;
      if (!['machine', 'client'].includes(role)) return reject(connection, 'HELLO_INVALID', 'HELLO needs payload.role = machine|client', { close: true });
      if (!frame.machineId) return reject(connection, 'HELLO_INVALID', 'HELLO needs machineId', { close: true });
      if (role === 'machine' && machines.has(frame.machineId) && machines.get(frame.machineId) !== connection) {
        // Two writers for one machine would mean two owners of the same sessions.
        return reject(connection, 'MACHINE_ALREADY_CONNECTED', `Machine ${frame.machineId} is already connected`, { close: true });
      }
      session.role = role;
      session.machineId = frame.machineId;
      session.deviceId = typeof frame.payload?.deviceId === 'string' ? frame.payload.deviceId : null;
      if (role === 'machine') {
        machines.set(frame.machineId, connection);
        await state.setPresence(frame.machineId, config.presenceTtlMs);
        logger('info', { event: 'machine_online', machineId: frame.machineId });
      } else {
        if (!clients.has(frame.machineId)) clients.set(frame.machineId, new Set());
        clients.get(frame.machineId).add(connection);
        logger('info', { event: 'client_online', machineId: frame.machineId, deviceId: session.deviceId });
      }
      send(connection, createEnvelope({ type: 'AUTH_OK', machineId: frame.machineId, payload: { role, protocolVersion: frame.v } }));
      return true;
    }

    async function forwardToMachine(frame) {
      const peer = machines.get(frame.machineId);
      if (peer) { send(peer, frame); return; }
      // The machine may be connected to another relay instance.
      if (await state.isPresent(frame.machineId)) { await state.publish(frame.machineId, frame); return; }
      reject(connection, 'MACHINE_OFFLINE', `Machine ${frame.machineId} is offline`);
    }

    function forwardToClients(frame) {
      const peers = [...machinePeers(frame.machineId)];
      if (frame.type === 'EVENT') {
        for (const peer of peers) {
          const client = peer.relaySession;
          if (client?.attached.has(frame.sessionId)) send(peer, frame);
        }
        return;
      }
      if (frame.type === 'MACHINE_STATUS' || frame.type === 'SESSION_LIST') {
        for (const peer of peers) send(peer, frame);
        return;
      }
      // Replies (COMMAND_ACK/AUTH_*/ERROR): the addressed device only, otherwise
      // every client of this machine.
      const addressed = frame.to ? peers.filter(peer => peer.relaySession?.deviceId === frame.to) : peers;
      for (const peer of addressed) send(peer, frame);
    }

    async function handle(text) {
      if (session.closed) return false;
      let frame;
      try { frame = parseEnvelope(text); }
      catch (error) { reject(connection, error.code || 'PROTOCOL_INVALID', error.message, { close: error.code === 'FRAME_TOO_LARGE' }); return false; }

      if (!(await state.rateLimit(rateKey, { limit: config.maxFramesPerSecond, windowMs: 1000 }))) {
        return reject(connection, 'RATE_LIMITED', 'Too many frames', { close: true }), false;
      }
      if (frame.type === 'PING') { send(connection, createEnvelope({ type: 'PONG' })); return true; }
      if (frame.type === 'HELLO') return Boolean(await hello(frame));
      if (!session.role) return reject(connection, 'HELLO_REQUIRED', 'Send HELLO before anything else', { close: true }), false;
      if (frame.machineId && frame.machineId !== session.machineId) {
        return reject(connection, 'MACHINE_MISMATCH', 'Frame addresses another machine', { close: true }), false;
      }
      // A machine frame is proof of life; refreshing costs nothing extra.
      if (session.role === 'machine') await state.setPresence(session.machineId, config.presenceTtlMs);

      if (session.role === 'client') {
        if (['ATTACH', 'DETACH'].includes(frame.type)) {
          if (frame.type === 'ATTACH') {
            if (session.attached.size >= config.maxAttachedSessions && !session.attached.has(frame.sessionId)) {
              session.attached.delete(frame.sessionId);
              return reject(connection, 'TOO_MANY_SESSIONS', `At most ${config.maxAttachedSessions} sessions per client`), false;
            }
            session.attached.add(frame.sessionId);
          } else session.attached.delete(frame.sessionId);
        }
        await forwardToMachine(frame);
        return true;
      }

      forwardToClients(frame);
      return true;
    }

    async function close() {
      if (session.closed) return;
      session.closed = true;
      if (session.role === 'machine' && machines.get(session.machineId) === connection) {
        machines.delete(session.machineId);
        await state.clearPresence(session.machineId);
        // Clients must learn about it instead of waiting forever.
        const status = createEnvelope({ type: 'MACHINE_STATUS', machineId: session.machineId, payload: { online: false } });
        for (const peer of machinePeers(session.machineId)) send(peer, status);
        clients.delete(session.machineId);
        logger('info', { event: 'machine_offline', machineId: session.machineId });
      }
      if (session.role === 'client') {
        const peers = clients.get(session.machineId);
        peers?.delete(connection);
        if (peers && !peers.size) clients.delete(session.machineId);
      }
    }

    connection.relaySession = session;
    session.handle = handle;
    session.close = close;
    session.hello = hello;
    // The transport owns the close hook (connection.onClose); the relay must not
    // shadow it, or a live connection would be closed the moment it is attached.
    return session;
  }

  return {
    attach,
    // Diagnostics only: never exposes payloads.
    stats() {
      return {
        machines: machines.size,
        clients: [...clients.values()].reduce((total, peers) => total + peers.size, 0)
      };
    }
  };
}
