#!/usr/bin/env node
// Минимальный тестовый "app"/"proxy" для изолированного supervisor-harness
// (tests/isolation/lan-supervisor.test.mjs): HTTP /api/health -> 200.
// Никакого доступа к боевым данным, портам и конфигу TaskBridge.
import http from 'node:http';

const port = Number(process.env.PORT || 5599);
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ health: 'ok', pid: process.pid }));
});
server.listen(port, '127.0.0.1', () => console.log(`[mini] listening ${port} pid=${process.pid}`));
process.on('SIGTERM', () => process.exit(0));
