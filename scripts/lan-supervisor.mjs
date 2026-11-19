#!/usr/bin/env node
// Supervisor for the detached LAN pair (start-lan.mjs start/restart).
//
// Why: the pair runs detached with no parent. On 2026-11-19 the app server
// died silently between 19:46 and 22:25 (nothing in lan-app.log) and the proxy
// kept pointing at the dead upstream — the phone had no connection for ~40
// minutes until a manual restart. This loop watches data/lan.json and re-runs
// the standard lifecycle (restart-lan-now, which owns the restart lock and the
// report) when the app process is gone or its health stays dead.
//
// Rules:
//   - a running restart (lan-restart.lock) is never raced;
//   - a young app process (< bootGraceMs) is still booting — not a failure;
//   - a missing lan.json for several ticks means `stop` was called — exit;
//   - another live supervisor replaces this one (pid recorded in
//     data/lan-supervisor.json).
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTaskBridgeProcess } from '../src/instance-lock.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA = process.env.TASKBRIDGE_DATA_DIR ? path.resolve(process.env.TASKBRIDGE_DATA_DIR) : path.join(root, 'data');
const STATE = path.join(DATA, 'lan.json');
const SELF_FILE = path.join(DATA, 'lan-supervisor.json');
const RESTART_LOCK = path.join(DATA, 'lan-restart.lock');
const LOG = path.join(DATA, 'lan-supervisor.log');
const TICK_MS = 5000;
const DEAD_TICKS = 2;            // 10 s of a missing process before a restart
const UNHEALTHY_TICKS = 12;      // 60 s of a dead health before a restart
const log = text => fs.appendFileSync(LOG, `${new Date().toISOString()} ${text}\n`, 'utf8');

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const alive = async (pid, marker) => {
  if (!pid) return false;
  try { return await import('../src/instance-lock.mjs').then(m => m.isTaskBridgeProcess(pid, marker)); }
  catch { return false; }
};
const health = async port => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch { return false; }
};

async function main() {
  const self = { pid: process.pid, startedAt: new Date().toISOString() };
  const previous = readJson(SELF_FILE);
  if (previous?.pid && previous.pid !== process.pid && await alive(previous.pid, 'lan-supervisor.mjs')) {
    console.log(`[supervisor] already running as pid ${previous.pid}`);
    return 0;
  }
  fs.writeFileSync(SELF_FILE, JSON.stringify(self, null, 2));
  log(`supervisor started (pid ${process.pid})`);

  let missingTicks = 0;
  let deadTicks = 0;
  let unhealthyTicks = 0;
  let restarting = false;
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, TICK_MS));
    try {
      const replacement = readJson(SELF_FILE);
      if (replacement?.pid && replacement.pid !== process.pid && await alive(replacement.pid, 'lan-supervisor.mjs')) {
        log('replaced by a newer supervisor, exiting');
        return 0;
      }
      const lock = readJson(RESTART_LOCK);
      if (lock?.pid && await alive(lock.pid, 'restart-lan-now.mjs')) continue; // a restart is running

      const state = readJson(STATE);
      if (!state) {
        // `stop` removes lan.json; a restart rewrites it within seconds.
        missingTicks += 1;
        if (missingTicks >= 3) { log('no lan.json — the pair was stopped, exiting'); return 0; }
        continue;
      }
      missingTicks = 0;

      const appAlive = await alive(state.appPid, 'server.mjs');
      const proxyAlive = await alive(state.proxyPid, 'proxy.mjs');
      if (!appAlive || !proxyAlive) {
        deadTicks += 1;
        unhealthyTicks = 0;
        if (deadTicks >= DEAD_TICKS && !restarting) {
          restarting = true;
          log(`app ${state.appPid} / proxy ${state.proxyPid} dead (app alive=${appAlive}, proxy alive=${proxyAlive}) — restarting the pair`);
          const worker = spawn(process.execPath, [path.join(root, 'scripts', 'restart-lan-now.mjs'), '--delay-ms=0'], {
            cwd: root, detached: true, windowsHide: true, stdio: 'ignore',
          });
          worker.unref();
          // Restart-lan-now rewrites lan.json and spawns a new supervisor.
          continue;
        }
        continue;
      }
      deadTicks = 0;

      const healthy = await health(state.internalPort);
      if (!healthy) {
        unhealthyTicks += 1;
        if (unhealthyTicks >= UNHEALTHY_TICKS && !restarting) {
          restarting = true;
          log(`app ${state.appPid} answers nothing on ${state.internalPort} for ${unhealthyTicks * (TICK_MS / 1000)} s — restarting the pair`);
          const worker = spawn(process.execPath, [path.join(root, 'scripts', 'restart-lan-now.mjs'), '--delay-ms=0'], {
            cwd: root, detached: true, windowsHide: true, stdio: 'ignore',
          });
          worker.unref();
          continue;
        }
      } else {
        unhealthyTicks = 0;
        restarting = false;
      }
    } catch (error) {
      log(`supervisor tick failed: ${error?.message || error}`);
    }
  }
}

process.exitCode = await main();
