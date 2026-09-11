#!/usr/bin/env node
// Detached launcher for the split mode (host + gateway as separate OS
// processes). Opt-in: the default `npm start` / `taskbridge start` still run
// the legacy monolith (src/server.mjs). Run the split with:
//   npm run start:split
// Stop it by killing the PIDs in data/split.json (both processes).
//
// env: TASKBRIDGE_DATA_DIR (defaults to <root>/data), HOST_PORT, GATEWAY_PORT.

import { spawn } from 'node:child_process';
import fs, { mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_ROOT = process.env.TASKBRIDGE_DATA_DIR ? path.resolve(process.env.TASKBRIDGE_DATA_DIR) : path.join(ROOT, 'data');
mkdirSync(DATA_ROOT, { recursive: true });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

async function portListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(200, () => { s.destroy(); resolve(false); });
  });
}

async function main() {
  const config = await (await import('../src/config.mjs')).loadConfig(ROOT);
  const hostPort = process.env.HOST_PORT ? Number(process.env.HOST_PORT) : await freePort();
  const gatewayPort = process.env.GATEWAY_PORT ? Number(process.env.GATEWAY_PORT) : await freePort();
  const log = (name) => fs.openSync(path.join(DATA_ROOT, `split-${name}.log`), 'a');

  const host = spawn(process.execPath, ['src/host.mjs'], {
    cwd: ROOT, detached: true, windowsHide: true,
    env: { ...process.env, TASKBRIDGE_DATA_DIR: DATA_ROOT, HOST_PORT: String(hostPort) },
    stdio: ['ignore', log('host'), log('host')],
  });
  host.unref();

  // Wait for the host's IPC port, then launch the gateway.
  const deadline = Date.now() + 15000;
  let up = false;
  while (Date.now() < deadline && !up) { up = await portListening(hostPort); if (!up) await new Promise((r) => setTimeout(r, 200)); }
  if (!up) throw new Error('host did not open its IPC port');

  const gateway = spawn(process.execPath, ['src/gateway.mjs'], {
    cwd: ROOT, detached: true, windowsHide: true,
    env: { ...process.env, TASKBRIDGE_DATA_DIR: DATA_ROOT, HOST_PORT: String(hostPort), GATEWAY_PORT: String(gatewayPort) },
    stdio: ['ignore', log('gateway'), log('gateway')],
  });
  gateway.unref();

  fs.writeFileSync(path.join(DATA_ROOT, 'split.json'), JSON.stringify({
    hostPid: host.pid, gatewayPid: gateway.pid, hostPort, gatewayPort,
    startedAt: new Date().toISOString(),
  }, null, 2));

  console.log(`[split] host ${host.pid}  -> IPC 127.0.0.1:${hostPort}`);
  console.log(`[split] gateway ${gateway.pid} -> http://127.0.0.1:${gatewayPort}`);
  console.log(`[split] data ${DATA_ROOT}  (pids in data/split.json, logs split-*.log)`);
  console.log(`[split] server.port from config ignored; gateway is on ${gatewayPort}`);
  return 0;
}

main().then((c) => process.exit(c), (e) => { console.error('[split] ' + (e?.message || e)); process.exit(1); });
