#!/usr/bin/env node
// A throwaway TaskBridge on fake-pi for clients' integration tests (the KMP
// core tests drive it). Prints one JSON line {"base": "..."} when ready, then
// reads commands from stdin, one per line:
//   restart  — restart the server process (same data), answers "restarted"
//   down <ms> — the server is unreachable for that long, then comes back on the
//               same port; answers "up" (used by the two-level health test)
// Closing stdin shuts everything down.

import readline from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';

const fixture = await startFixture();
process.stdout.write(JSON.stringify({ base: fixture.base }) + '\n');

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  if (line.trim() === 'release-heavy') {
    await fs.writeFile(path.join(fixture.root, 'heavy-stream.release'), 'released');
    process.stdout.write('heavy-released\n');
  }
  if (line.trim() === 'restart') {
    await fixture.restart();
    process.stdout.write('restarted\n');
  }
  // down <ms>: сервер уходит и возвращается на том же порту. Так проверяется
  // поведение клиента, пока связь есть только частично (план 4.2).
  const down = /^down (\d+)$/.exec(line.trim());
  if (down) {
    await fixture.restart(Number(down[1]));
    process.stdout.write('up\n');
  }
});
lines.on('close', async () => {
  await fixture.close();
  process.exit(0);
});
