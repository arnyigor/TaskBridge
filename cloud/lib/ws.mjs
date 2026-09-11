import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

// Minimal RFC 6455 server for the relay, without dependencies.
//
// Only what the relay needs: the HTTP upgrade handshake, text frames (including
// fragmented ones), ping/pong and the close handshake. Binary frames are
// accepted but rejected as unsupported, because the client protocol is JSON
// text; large payloads travel as file references, not as big frames.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODES = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

export const WS_DEFAULTS = {
  maxFrameBytes: 256 * 1024,   // matches src/cloud/protocol.mjs MAX_FRAME_BYTES
  maxMessageBytes: 1024 * 1024
};

const CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  TOO_LARGE: 1009
};

/** Server → client frame (never masked). */
export function encodeFrame(payload, opcode = OPCODES.text) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const header = [];
  header.push(0x80 | opcode);
  if (data.length < 126) header.push(data.length);
  else if (data.length < 65536) header.push(126, (data.length >> 8) & 0xff, data.length & 0xff);
  else {
    header.push(127, 0, 0, 0, 0,
      (data.length >>> 24) & 0xff, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff);
  }
  return Buffer.concat([Buffer.from(header), data]);
}

/** Client frame parser: accumulates bytes and yields whole messages. */
export function createFrameParser({ maxMessageBytes = WS_DEFAULTS.maxMessageBytes } = {}) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentBytes = 0;

  function parse() {
    const messages = [];
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < offset + 2) break;
        length = buffer.readUInt16BE(offset); offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) break;
        const high = buffer.readUInt32BE(offset);
        const low = buffer.readUInt32BE(offset + 4);
        if (high !== 0) return { error: CLOSE.TOO_LARGE };
        length = low; offset += 8;
      }
      if (masked) {
        if (buffer.length < offset + 4) break;
        offset += 4; // masking key position; payload is unmasked below
      }
      if (buffer.length < offset + length) break;
      const maskKey = masked ? buffer.subarray(offset - 4, offset) : null;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];

      if (opcode === OPCODES.close) { messages.push({ type: 'close', payload }); continue; }
      if (opcode === OPCODES.ping) { messages.push({ type: 'ping', payload }); continue; }
      if (opcode === OPCODES.pong) { messages.push({ type: 'pong', payload }); continue; }
      if (opcode === OPCODES.binary) return { error: CLOSE.UNSUPPORTED_DATA };
      if (![OPCODES.text, OPCODES.continuation].includes(opcode)) return { error: CLOSE.PROTOCOL_ERROR };

      if (opcode === OPCODES.text && fragments.length) return { error: CLOSE.PROTOCOL_ERROR };
      fragmentBytes += payload.length;
      if (fragmentBytes > maxMessageBytes) return { error: CLOSE.TOO_LARGE };
      fragments.push(payload);
      if (!fin) continue;
      const message = Buffer.concat(fragments).toString('utf8');
      fragments = [];
      fragmentBytes = 0;
      messages.push({ type: 'text', text: message });
    }
    return { messages };
  }

  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      return parse();
    }
  };
}

/**
 * A relay connection over one socket: text goes in and out, ping is answered,
 * close is a handshake. Shaped exactly like what createRelay() expects
 * ({ send, close }) so the relay core does not know about sockets.
 */
export function createSocketConnection(socket, { maxFrameBytes = WS_DEFAULTS.maxFrameBytes, maxMessageBytes = WS_DEFAULTS.maxMessageBytes, logger = () => {} } = {}) {
  const events = new EventEmitter();
  const connection = {
    events,
    closed: false,
    send(text) {
      if (connection.closed) return;
      const frame = encodeFrame(text, OPCODES.text);
      if (frame.length > maxFrameBytes + 16) {
        logger('warn', { event: 'ws_out_too_large', bytes: frame.length });
        connection.close(CLOSE.TOO_LARGE, 'frame too large');
        return;
      }
      socket.write(frame);
    },
    close(code = CLOSE.NORMAL, reason = '') {
      if (connection.closed) return;
      connection.closed = true;
      const reasonBytes = Buffer.from(String(reason).slice(0, 120), 'utf8');
      const payload = Buffer.alloc(2 + reasonBytes.length);
      payload.writeUInt16BE(code, 0);
      reasonBytes.copy(payload, 2);
      try { socket.write(encodeFrame(payload, OPCODES.close)); } catch { /* peer already gone */ }
      socket.end();
    },
    onClose(handler) { events.once('close', handler); }
  };

  const parser = createFrameParser({ maxMessageBytes });
  socket.on('data', chunk => {
    // One oversized frame must not be able to grow the read buffer without bound.
    if (chunk.length > maxFrameBytes * 2) { logger('warn', { event: 'ws_in_too_large', bytes: chunk.length }); connection.close(CLOSE.TOO_LARGE, 'frame too large'); return; }
    const result = chunk && parser.push(chunk);
    if (result.error) { logger('warn', { event: 'ws_protocol_error', code: result.error }); connection.close(result.error, 'protocol error'); return; }
    for (const message of result.messages || []) {
      if (message.type === 'text') events.emit('message', message.text);
      else if (message.type === 'ping') { if (!connection.closed) socket.write(encodeFrame(message.payload, OPCODES.pong)); }
      else if (message.type === 'close') connection.close(CLOSE.NORMAL, '');
    }
  });
  const finish = () => {
    if (!connection.closed) { connection.closed = true; socket.end(); }
    events.emit('close', { code: CLOSE.GOING_AWAY });
  };
  socket.on('close', finish);
  socket.on('error', error => { logger('warn', { event: 'ws_socket_error', message: error.message }); finish(); });
  return connection;
}

/**
 * Attaches the relay to an HTTP(S) server on `path` (default /api/relay).
 * `onConnection(connection, request)` receives a ready connection.
 */
export function attachWebSocketServer(server, { path = '/api/relay', onConnection, logger = () => {}, ...options } = {}) {
  if (typeof onConnection !== 'function') throw new Error('onConnection is required');
  server.on('upgrade', (request, socket) => {
    let pathname;
    try { pathname = new URL(request.url, 'http://localhost').pathname; } catch { socket.destroy(); return; }
    if (pathname !== path) { socket.destroy(); return; }
    const key = request.headers['sec-websocket-key'];
    if (String(request.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', ''
    ].join('\r\n'));
    // Nagle would delay small frames such as PING/PONG.
    socket.setNoDelay?.(true);
    const connection = createSocketConnection(socket, { logger, ...options });
    onConnection(connection, request);
  });
  return { path };
}
