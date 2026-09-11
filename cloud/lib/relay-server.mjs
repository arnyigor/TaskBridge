import http from 'node:http';
import { attachWebSocketServer } from './ws.mjs';
import { createMemoryRelayState, createRelay } from './relay.mjs';

// Binds the relay to a real HTTP server: the socket layer stays here, the routing
// policy lives in relay.mjs and the shared state in a state adapter (memory
// locally, Upstash Redis on Vercel).

export function createRelayServer({
  path = '/api/relay',
  state = createMemoryRelayState(),
  logger = () => {},
  limits = {},
  maxFrameBytes,
  maxMessageBytes
} = {}) {
  const relay = createRelay({ state, logger, limits });
  const http_server_holder = { server: null, connections: new Set() };

  function handleConnection(connection, request) {
    const session = relay.attach(connection);
    http_server_holder.connections.add(connection);
    logger('info', { event: 'relay_connection', path: request?.url || null });
    connection.events.on('message', text => { session.handle(text).catch(error => logger('error', { event: 'relay_handle_failed', message: error.message })); });
    connection.onClose(() => {
      http_server_holder.connections.delete(connection);
      session.close().catch(() => {});
    });
  }

  return {
    relay,
    state,
    // Attach to an existing server (the local cloud host) ...
    attach(server) {
      http_server_holder.server = server;
      attachWebSocketServer(server, { path, onConnection: handleConnection, logger, ...(maxFrameBytes ? { maxFrameBytes } : {}), ...(maxMessageBytes ? { maxMessageBytes } : {}) });
      return this;
    },
    // ... or run one for tests and local experiments.
    async listen({ port = 0, host = '127.0.0.1' } = {}) {
      const server = http.createServer((req, res) => {
        if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', ...relay.stats() })); return; }
        res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}');
      });
      this.attach(server);
      await new Promise(resolve => server.listen(port, host, resolve));
      const address = server.address();
      return {
        server,
        url: `ws://${host}:${address.port}${path}`,
        stats: () => relay.stats(),
        close: async () => {
          for (const connection of [...http_server_holder.connections]) connection.close(1001, 'server closing');
          await new Promise(resolve => server.close(resolve));
        }
      };
    }
  };
}
