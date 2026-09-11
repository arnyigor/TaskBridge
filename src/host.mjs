#!/usr/bin/env node
// AgentHost process (TZ step 5, P-2): owns the agent side (TaskManager + Pi +
// router + store + instance lock) and serves it to a gateway over the IPC
// transport. Headless: binds no HTTP. The gateway is a separate process.
//
// Usage:
//   node src/host.mjs                 # loopback ephemeral port; prints it
//   HOST_PORT=8790 node src/host.mjs   # fixed loopback port
//
// The IPC token is persisted to data/host-ipc.json (persistToken), which the
// gateway reads to authenticate. If this process is terminated, the Pi
// processes it owns are closed cleanly via TaskManager.close().

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentHost } from './agent-host.mjs';
import { loadConfig } from './config.mjs';

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_ROOT = process.env.TASKBRIDGE_DATA_DIR ? path.resolve(process.env.TASKBRIDGE_DATA_DIR) : path.join(ROOT_DIR, 'data');
const config = await loadConfig(ROOT_DIR);

const hostPort = Number(process.env.HOST_PORT) > 0 ? Number(process.env.HOST_PORT) : 0;
const host = new AgentHost({ config, dataRoot: DATA_ROOT, rootDir: ROOT_DIR, hostPort });

async function shutdown() {
  console.log('[AgentHost] shutting down …');
  await host.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await host.init();
  const { port, tokenFile } = await host.startIpc();
  console.log(`[AgentHost] ready: 127.0.0.1:${port} (token: ${tokenFile})`);
} catch (error) {
  console.error(`[AgentHost] ${error.message}`);
  process.exit(1);
}
