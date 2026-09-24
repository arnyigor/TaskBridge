#!/usr/bin/env node
// A throwaway TaskBridge on fake-pi for clients' integration tests (the KMP
// core tests drive it). Prints one JSON line {"base": "..."} when ready, then
// reads commands from stdin, one per line:
//   restart  — restart the server process (same data), answers "restarted"
// Closing stdin shuts everything down.

import readline from 'node:readline';
import { startFixture } from './server-fixture.mjs';

const fixture = await startFixture();
process.stdout.write(JSON.stringify({ base: fixture.base }) + '\n');

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  if (line.trim() === 'restart') {
    await fixture.restart();
    process.stdout.write('restarted\n');
  }
});
lines.on('close', async () => {
  await fixture.close();
  process.exit(0);
});
