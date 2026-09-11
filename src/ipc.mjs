// AgentHost ⇄ gateway IPC transport (TZ step 5 / P-2 foundation).
//
// Two processes must talk so that the gateway can restart without killing the
// agent. This module is intentionally transport-only: a token-authenticated,
// framed JSON exchange over a loopback TCP socket. It carries both
// request/response commands (REQ/RES, id-correlated) and a one-way event push
// (EVENT, with SUBSCRIBE/UNSUBSCRIBE). Newline-delimited JSON framing is
// enough for this scale and keeps framing trivial to debug.
//
// Nothing here touches task state: the host still owns SQLite and the Pi
// processes. The gateway stays a thin client of the host.

import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const NEWLINE = '\n';
const HELLO_TIMEOUT = 5000;
const CALL_TIMEOUT = 30000;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

// --- shared helpers ----------------------------------------------------------

function encode(obj) {
  const text = JSON.stringify(obj);
  return Buffer.from(text + NEWLINE, 'utf8');
}

// Reads one JSON object from a buffer that grows until it contains a newline.
// Returns { obj, rest } or null when the frame is not complete yet.
function parseFrame(buf) {
  let bufText = Buffer.isBuffer(buf) ? buf.toString('utf8') : buf;
  const idx = bufText.indexOf(NEWLINE);
  if (idx === -1) return null;
  let obj;
  try { obj = JSON.parse(bufText.slice(0, idx)); }
  catch { obj = null; }
  const rest = bufText.slice(idx + 1);
  return { obj, rest: Buffer.from(rest, 'utf8') };
}

async function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// --- host side ---------------------------------------------------------------

// Owns one accepted client socket: authenticates HELLO, dispatches REQ and
// broadcasts EVENT. `handlers.request(name, args)` is the async handler.
export class HostIpcConnection {
  constructor(socket, { token, handlers }) {
    this.socket = socket;
    this.token = token;
    this.handlers = handlers;
    this.authenticated = false;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
  }
  #onData(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_FRAME_BYTES) { this.close(); return; }
    let frame;
    while (!this.closed && (frame = parseFrame(this.buffer))) {
      this.buffer = frame.rest;
      this.#onFrame(frame.obj);
    }
  }
  async #onFrame(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.type === 'HELLO') {
      const ok = obj.token && obj.token === this.token;
      this.authenticated = ok;
      this.send({ type: ok ? 'HELLO_OK' : 'HELLO_DENIED' });
      if (!ok) this.close();
      return;
    }
    if (!this.authenticated) { this.send({ type: 'ERR', error: 'unauthorized' }); return; }
    if (obj.type === 'REQ' && Number.isSafeInteger(obj.id)) {
      try {
        const data = await this.handlers.request(obj.name, obj.args || {});
        if (this.closed) return;
        this.send({ type: 'RES', id: obj.id, ok: true, data });
      } catch (error) {
        if (this.closed) return;
        this.send({ type: 'RES', id: obj.id, ok: false, error: { message: error?.message || String(error), code: error?.code || 'INTERNAL_ERROR' } });
      }
      return;
    }
    if (obj.type === 'SUBSCRIBE') { this.subscribed = true; return; }
    if (obj.type === 'UNSUBSCRIBE') { this.subscribed = false; return; }
  }
  send(obj) {
    if (this.closed) return false;
    try { this.socket.write(encode(obj)); return true; }
    catch { return false; }
  }
  emitEvent(type, data) {
    if (!this.subscribed) return;
    this.send({ type: 'EVENT', eventType: type, data });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.handlers.onClose?.();
  }
}

// Listens on 127.0.0.1:port, authenticates clients with `token`
// (timing-safe), and routes REQ to `handlers.request`. `handlers.request` may
// return synchronously or a Promise.
export class HostIpcServer extends EventEmitter {
  constructor({ port, token, handlers }) {
    super();
    this.port = port;
    this.token = token;
    this.handlers = handlers;
    this.connections = new Set();
    this.server = null;
    this.closed = false;
  }
  start() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        const conn = new HostIpcConnection(socket, {
          token: this.token,
          handlers: this.handlers,
          onClose: () => this.connections.delete(conn),
        });
        this.connections.add(conn);
        this.emit('connection', conn);
      });
      this.server = server;
      this.#armTimeoutTimer();
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve(this.address());
      });
    });
  }
  #armTimeoutTimer() {
    // Close connections that never said HELLO, so a half-open client does not
    // pin a file descriptor forever.
    const id = setInterval(() => {
      for (const conn of this.connections) {
        if (!conn.authenticated) conn.close();
      }
    }, HELLO_TIMEOUT).unref();
    this.timeoutTimer = id;
  }
  address() { return this.server?.address(); }
  broadcast(type, data) {
    for (const conn of this.connections) conn.emitEvent(type, data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timeoutTimer) { clearInterval(this.timeoutTimer); this.timeoutTimer = null; }
    for (const conn of this.connections) conn.close();
    this.connections.clear();
    if (this.server) { try { this.server.close(); } catch {} this.server = null; }
  }
}

// --- client side -------------------------------------------------------------

// Connects to a HostIpcServer, authenticates with `token`, and exposes
// `request(name, args)` (id-correlated, with a timeout) plus `on('event',
// type, data)` for pushed events. Reconnects with exponential backoff so a
// gateway restart / host restart can re-establish the channel.
export class GatewayClient extends EventEmitter {
  constructor({ host, port, token, callTimeout = CALL_TIMEOUT, reconnect = true }) {
    super();
    this.host = host || '127.0.0.1';
    this.port = port;
    this.token = token;
    this.callTimeout = callTimeout;
    this.reconnect = reconnect;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    this.connected = false;
    this.authenticated = false;
    this.subscribed = false;
    this.closed = false;
    this.backoff = 0;
  }
  connect() {
    if (this.closed) return Promise.reject(new Error('client closed'));
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      this.socket = socket;
      let settled = false;
      const fail = (error) => { if (!settled) { settled = true; reject(error); } };
      socket.once('error', fail);
      socket.on('connect', () => {
        socket.removeListener('error', fail);
        settled = true;
        this.connected = true;
        this.backoff = 0;
        this.#wireSocket();
        this.send({ type: 'HELLO', token: this.token });
        resolve();
      });
      socket.on('close', () => this.#onDisconnect());
      socket.on('error', () => {});
    });
  }
  #wireSocket() {
    this.socket.on('data', (chunk) => this.#onData(chunk));
  }
  #onData(chunk) {
    if (!this.socket) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_FRAME_BYTES) { this.close(); return; }
    let frame;
    while (!this.closed && (frame = parseFrame(this.buffer))) {
      this.buffer = frame.rest;
      this.#onFrame(frame.obj);
    }
  }
  #onFrame(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.type === 'HELLO_OK') {
      this.authenticated = true;
      if (this.subscribed) this.send({ type: 'SUBSCRIBE' });
      this.emit('connect');
      return;
    }
    if (obj.type === 'HELLO_DENIED' || obj.type === 'ERR') {
      this.emit('error', new Error(obj.error || 'unauthorized'));
      this.close();
      return;
    }
    if (obj.type === 'EVENT') {
      this.emit('event', obj.eventType, obj.data);
      return;
    }
    if (obj.type === 'RES') {
      const waiter = this.pending.get(obj.id);
      if (!waiter) return;
      this.pending.delete(obj.id);
      if (obj.ok) waiter.resolve(obj.data);
      else waiter.reject(Object.assign(new Error(obj.error?.message || 'ipc error'), { code: obj.error?.code }));
      return;
    }
  }
  send(obj) {
    if (!this.socket || !this.connected) return false;
    try { this.socket.write(encode(obj)); return true; }
    catch { return false; }
  }
  async request(name, args = {}) {
    if (this.closed) throw new Error('ipc client closed');
    if (!this.authenticated) await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`ipc timeout: ${name}`)); }, this.callTimeout);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send({ type: 'REQ', id, name, args });
    });
  }
  subscribe() {
    this.subscribed = true;
    this.send({ type: 'SUBSCRIBE' });
  }
  #onDisconnect() {
    this.connected = false;
    this.authenticated = false;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(new Error('ipc disconnected'));
    this.emit('disconnect');
    if (this.closed || !this.reconnect) return;
    const delay = 100 * Math.pow(2, Math.min(this.backoff, 6)) + Math.floor(Math.random() * 100);
    this.backoff++;
    setTimeout(() => {
      if (this.closed) return;
      this.connect().catch(() => {});
    }, delay);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.socket) { try { this.socket.removeAllListeners('data'); this.socket.destroy(); } catch {} this.socket = null; }
    this.connected = false;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(new Error('ipc client closed'));
  }
}

// Generates a fresh random token and persists it to `file` so a gateway that
// restarts can read the same secret. 0660 on POSIX (owner + group only).
// This is an internal gateway⇄host secret, not the cloud machine secret.
export function persistToken(file) {
  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, token, { mode: 0o660 });
  } catch { /* best effort; the gateway reads the file as-is later */ }
  return token;
}

// Reads a token previously written by persistToken; null when missing.
export function readToken(file) {
  try { return fs.readFileSync(file, 'utf8').trim() || null; }
  catch { return null; }
}
