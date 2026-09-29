// Starts one configured local model server OUTSIDE the caller's process tree.
//
// Why this file exists: `detached: true` keeps a child alive when its parent
// exits, but it does NOT leave the parent chain — and `taskkill /T`, which
// scripts/restart-lan-now.mjs runs on the app, walks that chain. So a Strata
// server spawned directly by TaskBridge was killed by every restart (observed
// 2026-09-29: the server's log stops at 07:32:59 local, the app's restart
// marker is written at 07:33:03, and the next local request — Pi's compaction
// summary — died with "Connection error." in 26 ms because nothing listened on
// 8082 any more), although a 4-minute model load is exactly what has to outlive
// a restart.
//
// This launcher is the intermediate process: it starts the server detached and
// exits at once, leaving the server with a parent pid that is already gone —
// `taskkill /T` cannot walk through it. The same trick keeps
// scripts/restart-lan-now.mjs itself alive across the restart it performs.
//
// Usage: node orphan-launcher.mjs <command> <cwd|-> [args…]
// Prints the server's pid on stdout, so the caller can still stop THAT process
// (the launcher itself is gone by then).

import { spawn } from 'node:child_process';

const [command, cwd, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write('orphan-launcher: не задана команда запуска\n');
  process.exit(2);
}

const child = spawn(command, args, {
  cwd: cwd && cwd !== '-' ? cwd : undefined,
  env: process.env,
  windowsHide: true,
  detached: true,
  stdio: 'ignore'
});

// A bad command (ENOENT/EACCES) must reach the caller as a message, not as an
// uncaught exception: the parent reads this stderr and puts it in its error.
child.on('error', error => {
  process.stderr.write(`orphan-launcher: ${error.message}\n`);
  process.exit(1);
});

child.unref();
// Exit only once the pid is actually on the pipe; the parent waits for it.
process.stdout.write(`${child.pid}\n`, () => process.exit(0));
