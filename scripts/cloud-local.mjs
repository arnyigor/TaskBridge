#!/usr/bin/env node
// Scenario C: TaskBridge over the internet without Vercel and without Postgres.
//
// The cloud control plane runs on this PC (SQLite store in cloud/data/) and is
// published through a Cloudflare quick tunnel, so a phone on mobile data reaches
// the machine through the relay. Nothing is deployed anywhere; the PC stays the
// only executor, exactly as in docs/cloud-transport-status.md § 8 «Сценарий C».
//
//   node scripts/cloud-local.mjs start [--url <https://…>] [--no-tunnel]
//                                      [--restart [--delay-ms N]] [--apply]
//   node scripts/cloud-local.mjs status
//   node scripts/cloud-local.mjs probe         # does the public relay path work?
//   node scripts/cloud-local.mjs link          # pairing link for the phone
//   node scripts/cloud-local.mjs verify [--delay-ms N]
//   node scripts/cloud-local.mjs stop
//
// Everything it writes lives in data/cloud-local/ (ignored by git):
// creds.json, pids.json, state.json, cloud.log, tunnel.log, verify.md.
//
// `realtime` is not a live-appliable setting: POST /api/cloud/config does not
// accept it, so the machine starts its relay connector only at startup. That is
// why `start` writes config.json and tells you to restart instead of pretending
// the phone works right away; `--restart` schedules exactly that restart (the
// running server is the parent of the session that asked, so it has to happen in
// a process of its own — scripts/restart-and-verify.mjs).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateCredentials } from '../cloud/lib/credentials.mjs';
import crypto from 'node:crypto';
import { createEnvelope, serializeEnvelope, parseEnvelope } from '../src/cloud/protocol.mjs';
import { issueDeviceToken } from '../src/cloud/device-token.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = path.join(root, 'data', 'cloud-local');
const CREDS_FILE = path.join(stateDir, 'creds.json');
const PIDS_FILE = path.join(stateDir, 'pids.json');
const STATE_FILE = path.join(stateDir, 'state.json');
const CLOUD_LOG = path.join(stateDir, 'cloud.log');
const TUNNEL_LOG = path.join(stateDir, 'tunnel.log');
// cloudflared writes its own structured log here (--logfile): more reliable than
// reading the stdio of an npx → cmd → binary chain, which stayed empty on Windows.
const CLOUDFLARED_LOG = path.join(stateDir, 'cloudflared.log');
const VERIFY_REPORT = path.join(stateDir, 'verify.md');
const LINK_FILE = path.join(stateDir, 'pair-link.txt');
const CONFIG_FILE = path.join(root, 'config.json');

const DEFAULT_PORT = 8788;
const DEFAULT_LOCAL_PORT = 8787;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseArgs(argv) {
  const args = {
    command: argv[0] && !argv[0].startsWith('--') ? argv[0] : 'start',
    port: DEFAULT_PORT,
    localPort: DEFAULT_LOCAL_PORT,
    url: null,
    // Which tunnel provider publishes the local cloud host. cloudflared is the
    // default name in the docs, but its edge connection died here every minute
    // or two (QUIC dial timeouts, then 530/502 on a registered connector), while
    // tunnelmole held. Pick what actually works on this network.
    tunnel: 'tunnelmole',
    domain: null,
    // QUIC is the cloudflared default, but on networks that block UDP the edge
    // dial fails ("failed to dial to edge with quic: timeout") and the tunnel
    // answers 530 forever. http2 rides TCP/7844.
    protocol: 'http2',
    apply: true,
    restart: false,
    delayMs: 60_000,
    cloudflared: null
  };
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].split('=');
    const next = inline ?? argv[i + 1];
    if (key === '--port') args.port = Number(next);
    else if (key === '--local-port') args.localPort = Number(next);
    else if (key === '--url') args.url = String(next || '').replace(/\/+$/, '');
    else if (key === '--no-tunnel') args.tunnel = 'none';
    else if (key === '--tunnel') args.tunnel = String(next);
    else if (key === '--domain') args.domain = String(next || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    else if (key === '--protocol') args.protocol = String(next);
    else if (key === '--no-apply') args.apply = false;
    else if (key === '--restart') args.restart = true;
    else if (key === '--delay-ms') args.delayMs = Number(next);
    else if (key === '--cloudflared') args.cloudflared = next;
  }
  return args;
}

function readJsonSafe(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
async function waitFor(label, fn, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (error) { last = error; }
    await sleep(intervalMs);
  }
  return null;
}
async function getJson(url, { timeoutMs = 10_000, ...options } = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...options });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: response.status, body, text };
}
function tail(file, lines = 12) {
  try { return fs.readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n').trim(); } catch { return ''; }
}

// --- detached children (the launcher outlives the shell that started it) -----

function spawnDetached({ file, args, env, log, shell = false }) {
  const handle = fs.openSync(log, 'a');
  const child = spawn(file, args, {
    cwd: root,
    env: { ...process.env, ...env },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', handle, handle],
    shell
  });
  child.unref();
  return child.pid;
}
function killTree(pid) {
  if (!alive(pid)) return false;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {});
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  }
  return true;
}
function listeningPid(port) {
  return new Promise(resolve => {
    execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (error, stdout) => {
      if (error || !stdout) return resolve(null);
      for (const line of stdout.split('\n')) {
        const match = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/);
        if (match && Number(match[1]) === port) return resolve(Number(match[2]));
      }
      resolve(null);
    });
  });
}

// --- credentials (no Postgres, no Vercel: one machine, one owner) -----------

async function ensureCreds() {
  const saved = readJsonSafe(CREDS_FILE);
  if (saved?.machineSecret && saved?.userToken) return saved;
  const generated = generateCredentials({});
  const creds = {
    userToken: generated.userToken,
    ownerId: generated.ownerId,
    machineId: generated.machineId,
    machineName: generated.machineName,
    machineSecret: generated.machineSecret,
    machinesJson: generated.machinesJson,
    generatedAt: new Date().toISOString()
  };
  await writeJson(CREDS_FILE, creds);
  return creds;
}
function credsEnv(creds) {
  return {
    TASKBRIDGE_CLOUD_USER_TOKEN: creds.userToken,
    TASKBRIDGE_CLOUD_USER_ID: creds.ownerId,
    TASKBRIDGE_CLOUD_MACHINES: creds.machinesJson
  };
}

// --- cloud host -------------------------------------------------------------

async function ensureCloudHost(creds, port) {
  const pids = readJsonSafe(PIDS_FILE, {});
  if (alive(pids.cloudPid)) {
    const health = await getJson(`http://127.0.0.1:${port}/api/health`, { timeoutMs: 3_000 }).catch(() => null);
    if (health?.status === 200) {
      // A host left over from an older creds.json would answer the port but
      // reject this machine with 401 forever, so the credential is checked too.
      const check = await getJson(`http://127.0.0.1:${port}/api/bridge/heartbeat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${creds.machineSecret}`, 'x-taskbridge-machine': creds.machineId, 'content-type': 'application/json' },
        body: JSON.stringify({ machineId: creds.machineId, status: 'ONLINE', version: 'credential-check', protocolVersion: 2 })
      }).catch(() => null);
      if (check?.status === 200) return { pid: pids.cloudPid, reused: true };
      console.log(`облако:  процесс ${pids.cloudPid} не принимает секрет из creds.json (${check?.status ?? '—'}) — перезапускаю`);
      killTree(pids.cloudPid);
      await sleep(1_000);
    }
  }
  const pid = spawnDetached({
    file: process.execPath,
    args: ['cloud/server.mjs'],
    env: { ...credsEnv(creds), CLOUD_PORT: String(port), CLOUD_HOST: '127.0.0.1', CLOUD_STORE: `sqlite:${path.join(root, 'cloud', 'data', 'taskbridge-cloud.db')}` },
    log: CLOUD_LOG
  });
  const health = await waitFor('cloud health', async () => {
    const result = await getJson(`http://127.0.0.1:${port}/api/health`, { timeoutMs: 2_000 });
    return result.status === 200 ? result.body : null;
  }, { timeoutMs: 30_000 });
  if (!health) throw new Error(`Хост облака не поднялся на порту ${port}. Хвост ${CLOUD_LOG}:\n${tail(CLOUD_LOG)}`);
  return { pid, reused: false, health };
}

// --- public address ---------------------------------------------------------

// Every provider is started through npx so nothing has to be installed first;
// a native binary can be forced with --cloudflared <path>.
function npxCommand() {
  return process.platform === 'win32'
    ? { file: 'npx.cmd', shell: true }
    : { file: 'npx', shell: false };
}

function tunnelCommand(args) {
  if (args.tunnel === 'cloudflared') {
    if (args.cloudflared) return { command: [args.cloudflared, 'tunnel', '--url', `http://127.0.0.1:${args.port}`, '--no-autoupdate'], urlPattern: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/, log: CLOUDFLARED_LOG };
    return {
      command: ['npx', '--yes', 'cloudflared@latest', 'tunnel', '--url', `http://127.0.0.1:${args.port}`, '--no-autoupdate', '--protocol', args.protocol, '--logfile', CLOUDFLARED_LOG, '--loglevel', 'info'],
      urlPattern: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
      log: CLOUDFLARED_LOG
    };
  }
  if (args.tunnel === 'tunnelmole') {
    return { command: ['npx', '--yes', 'tunnelmole', String(args.port)], urlPattern: /https:\/\/[a-z0-9-]+\.tunnelmole\.net/, log: TUNNEL_LOG };
  }
  if (args.tunnel === 'ngrok') {
    // The free plan allows one static domain — pass it as --domain and the phone
    // keeps its address instead of re-pairing on every start.
    return {
      command: ['npx', '--yes', 'ngrok@latest', 'http', String(args.port), '--log', 'stdout', '--log-format', 'json', ...(args.domain ? ['--domain', args.domain] : [])],
      urlPattern: /https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.app/,
      log: TUNNEL_LOG
    };
  }
  throw new Error(`Неизвестный провайдер туннеля: ${args.tunnel} (cloudflared|tunnelmole|ngrok|none)`);
}

// PowerShell Start-Process, not stdio inheritance: through cmd → npx → node the
// redirected log stayed empty on Windows, and the tunnel's URL never appeared.
// The child gets real files, so it can also keep logging after this script exits.
function spawnTunnel(command, log) {
  if (process.platform !== 'win32') {
    return spawnDetached({ file: command[0], args: command.slice(1), log });
  }
  // npx must be addressed as npx.cmd here: Start-Process cannot run the shell
  // alias, and wrapping it in cmd.exe swallowed the child's output.
  const file = command[0] === 'npx' ? 'npx.cmd' : command[0];
  const quote = value => `'${String(value).replace(/'/g, "''")}'`;
  const script = [
    `Start-Process -FilePath ${quote(file)}`,
    `-ArgumentList @(${command.slice(1).map(quote).join(',')})`,
    `-WorkingDirectory ${quote(root)} -WindowStyle Hidden`,
    `-RedirectStandardOutput ${quote(log)} -RedirectStandardError ${quote(log.replace(/\.log$/, '.err.log'))}`
  ].join(' ');
  return spawnDetached({ file: 'powershell.exe', args: ['-NoProfile', '-Command', script], log: log.replace(/\.log$/, '.shell.log') });
}
async function ensureTunnel(args) {
  const pids = readJsonSafe(PIDS_FILE, {});
  const state = readJsonSafe(STATE_FILE, {});
  if (alive(pids.tunnelPid) && state.publicUrl && state.tunnel === args.tunnel
    && (await getJson(`${state.publicUrl}/api/health`, { timeoutMs: 8_000 }).catch(() => null))?.status === 200) {
    return { pid: pids.tunnelPid, url: state.publicUrl, reused: true };
  }
  if (alive(pids.tunnelPid)) console.log(`туннель: прошлый процесс ${pids.tunnelPid} не обслуживает ${state.publicUrl || '—'} — запускаю новый`);
  killTree(pids.tunnelPid);
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.writeFile(TUNNEL_LOG, '', 'utf8');
  await fsp.writeFile(CLOUDFLARED_LOG, '', 'utf8');
  const command = tunnelCommand(args);
  const pid = spawnTunnel(command.command, TUNNEL_LOG);
  const url = await waitFor('tunnel url', () => {
    const text = fs.readFileSync(command.log, 'utf8');
    return command.urlPattern.exec(text)?.[0] || null;
  }, { timeoutMs: 120_000, intervalMs: 1_000 });
  if (!url) throw new Error(`Туннель (${args.tunnel}) не выдал адрес за 120 с. Хвост ${command.log}:\n${tail(command.log, 10)}\n\nХвост ${TUNNEL_LOG}:\n${tail(TUNNEL_LOG, 10)}`);
  return { pid, url, reused: false };
}

// --- config.json (the machine side) ----------------------------------------

function cloudBlock({ url, creds }) {
  return {
    enabled: true,
    url,
    machineId: creds.machineId,
    machineSecret: creds.machineSecret,
    machineDisplayName: creds.machineName || null,
    authMode: 'bearer',
    realtime: true,
    protocolVersion: 2, // the wire protocol (src/cloud/protocol.mjs), not the cloud API's 1
    eventFlushMs: 100,
    pollIntervalMs: 1500,
    maxBatchEvents: 100,
    maxPayloadKb: 256,
    maxOutboxMb: 100,
    processedCommandLimit: 2000
  };
}
async function patchConfig({ url, creds }) {
  const config = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'));
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.writeFile(path.join(stateDir, 'config.backup.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const previous = config.cloud || {};
  config.cloud = { ...previous, ...cloudBlock({ url, creds }) };
  await fsp.writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return config.cloud;
}

// --- restart runner (detached, so it survives the session it was asked from) -

function scheduleRestart(delayMs) {
  const log = path.join(stateDir, 'restart-runner.log');
  const args = ['scripts/restart-and-verify.mjs', '--delay-ms', String(delayMs)];
  if (process.platform !== 'win32') return spawnDetached({ file: process.execPath, args, log });
  // PowerShell Start-Process: a process of its own, outside this session's tree —
  // restarting TaskBridge kills the tree of the session that asked for it.
  const script = [
    `Start-Process -FilePath '${process.execPath}'`,
    `-ArgumentList @(${args.map(value => `'${value}'`).join(',')})`,
    `-WorkingDirectory '${root}' -WindowStyle Hidden`,
    `-RedirectStandardOutput '${log}' -RedirectStandardError '${path.join(stateDir, 'restart-runner.err.log')}'`
  ].join(' ');
  return spawnDetached({ file: 'powershell.exe', args: ['-NoProfile', '-Command', script], log: path.join(stateDir, 'restart-shell.log') });
}

// --- commands ---------------------------------------------------------------

async function commandStart(args) {
  await fsp.mkdir(stateDir, { recursive: true });
  const creds = await ensureCreds();
  console.log(`TaskBridge: сценарий C (локальное облако + туннель, без базы)\n`);
  console.log(`машина:  ${creds.machineId} (${creds.machineName})`);
  console.log(`креды:   ${CREDS_FILE}`);

  const cloud = await ensureCloudHost(creds, args.port);
  console.log(`облако:  ${cloud.reused ? 'уже работало' : 'запущено'} — PID ${cloud.pid}, http://127.0.0.1:${args.port}`);

  const state = readJsonSafe(STATE_FILE, {});
  let publicUrl = args.url || null;
  let tunnelPid = null;
  if (!publicUrl && args.tunnel !== 'none') {
    const tunnel = await ensureTunnel(args);
    publicUrl = tunnel.url;
    tunnelPid = tunnel.pid;
    console.log(`туннель: ${tunnel.reused ? 'уже работал' : 'запущен'} — PID ${tunnel.pid}, ${publicUrl} (protocol ${args.protocol})`);
  } else if (publicUrl) {
    console.log(`адрес:  ${publicUrl} (--url)`);
  } else {
    console.log('туннель: выключен (--tunnel none) — телефон с мобильного интернета не подключится');
  }

  if (publicUrl) {
    const health = await waitFor('public health', async () => {
      const result = await getJson(`${publicUrl}/api/health`, { timeoutMs: 8_000 });
      return result.status === 200 ? result.body : null;
    }, { timeoutMs: 60_000, intervalMs: 2_000 });
    if (!health) {
      throw new Error([
        `${publicUrl}/api/health не отвечает — облако видно из интернета не будет.`,
        'Если Cloudflare отдаёт 530/1033 — туннель не поднял соединение: проверьте `--protocol http2` (UDP/QUIC часто заблокирован) и хвост лога ниже.',
        tail(CLOUDFLARED_LOG, 8)
      ].join('\n'));
    }
    console.log(`проверка: ${publicUrl}/api/health → store=${health.store}, durable=${health.durable}`);
    if (health.durable !== true) console.log('ВНИМАНИЕ: хранилище не durable — события не переживут рестарт облака.');
  }

  const pids = readJsonSafe(PIDS_FILE, {});
  if (!tunnelPid) killTree(pids.tunnelPid);
  await writeJson(PIDS_FILE, { ...pids, cloudPid: cloud.pid, tunnelPid: tunnelPid ?? null });
  await writeJson(STATE_FILE, { ...state, publicUrl: publicUrl || state.publicUrl || null, tunnel: args.tunnel, port: args.port, startedAt: new Date().toISOString() });

  if (publicUrl) {
    const cloud_ = await patchConfig({ url: publicUrl, creds });
    console.log(`config:  config.json → cloud.enabled=true, realtime=true, url=${cloud_.url}`);
    console.log(`         (бэкап прежнего config.json: ${path.join(stateDir, 'config.backup.json')})`);
  }

  // Applied live so a new tunnel address never needs a restart: the server
  // re-creates both the cloud worker and the relay connector from the new URL
  // (relay only when realtime is already on in the running process, which is
  // what config.json says and what start.cmd loaded).
  if (args.apply && publicUrl) {
    const applied = await getJson(`http://127.0.0.1:${args.localPort}/api/cloud/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, url: publicUrl, machineId: creds.machineId, machineSecret: creds.machineSecret, machineDisplayName: creds.machineName })
    }).catch(error => ({ status: 0, body: { error: error.message } }));
    console.log(`live:    POST /api/cloud/config → ${applied.status} ${JSON.stringify(applied.body)}`);
  }

  console.log('\nЧто дальше:');
  if (publicUrl) {
    const online = await probeRelay({ creds, publicUrl, timeoutMs: 15_000 }).catch(() => null);
    if (online?.requestOk) {
      console.log('  ПК уже на релее и отвечает через публичный адрес — телефону нужна только ссылка:');
    } else if (online?.authed) {
      console.log('  Релей отвечает, но ПК к нему не подключён (machine offline).' );
      console.log('  Перезапустите TaskBridge один раз, если в config.json только что появился realtime=true:');
      console.log('    npm run restart:verify -- --delay-ms 15000');
    } else {
      console.log('  Релей по публичному адресу недоступен — смотрите data/cloud-local/*.log и `npm run cloud:local -- probe`.');
    }
    console.log('  Ссылка для телефона (QR не обязателен):');
    console.log('    npm run cloud:local -- link');
  } else {
    console.log('  адреса из интернета нет — туннель не запущен.');
  }
  console.log('  Сквозная проверка: npm run cloud:local -- verify');
  console.log('  Отключить сценарий C: npm run cloud:local -- stop (и cloud.enabled=false в config.json)');

  if (args.restart) {
    const pid = scheduleRestart(args.delayMs);
    console.log(`\nперезапуск запланирован: PID ${pid}, через ${Math.round(args.delayMs / 1000)} с (отчёт: data/restart-report.md)`);
    if (publicUrl) console.log('после перезапуска: npm run cloud:local -- link');
  }
  return 0;
}

async function commandStatus(args) {
  const pids = readJsonSafe(PIDS_FILE, {});
  const state = readJsonSafe(STATE_FILE, {});
  const creds = readJsonSafe(CREDS_FILE);
  const local = await getJson(`http://127.0.0.1:${args.localPort}/debug/cloud`).catch(() => null);
  const cloud = await getJson(`http://127.0.0.1:${args.port}/api/health`).catch(() => null);
  const public_ = state.publicUrl ? await getJson(`${state.publicUrl}/api/health`, { timeoutMs: 10_000 }).catch(() => null) : null;
  const config = readJsonSafe(CONFIG_FILE, {});
  console.log(JSON.stringify({
    machine: creds ? { machineId: creds.machineId, machineName: creds.machineName } : null,
    cloudHost: { pid: pids.cloudPid ?? null, alive: alive(pids.cloudPid), health: cloud?.body ?? null, log: CLOUD_LOG },
    tunnel: { pid: pids.tunnelPid ?? null, alive: alive(pids.tunnelPid), url: state.publicUrl ?? null, publicHealth: public_?.body ?? null, log: TUNNEL_LOG, cloudflaredLog: CLOUDFLARED_LOG },
    localServer: { debug: local?.body ?? null },
    configCloud: config.cloud ? { enabled: config.cloud.enabled, url: config.cloud.url, realtime: config.cloud.realtime, machineId: config.cloud.machineId } : null,
    drift: config.cloud?.url && state.publicUrl && config.cloud.url !== state.publicUrl
      ? `config.json смотрит на ${config.cloud.url}, а туннель сейчас ${state.publicUrl} — телефону нужна новая ссылка (npm run cloud:local -- link)`
      : null
  }, null, 2));
  return 0;
}

async function commandLink(args) {
  const result = await getJson(`http://127.0.0.1:${args.localPort}/api/cloud/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Телефон ${new Date().toLocaleDateString('ru-RU')}` })
  }).catch(error => ({ status: 0, body: { error: { code: 'UNREACHABLE', message: error.message } } }));
  if (result.status !== 200 || !result.body?.url) {
    // The machine answers errors as { error: "текст", code: "…" } (see errorJson).
    const code = result.body?.code || result.status;
    const message = typeof result.body?.error === 'string' ? result.body.error : result.body?.error?.message || '';
    console.error(`Ссылку выпустить не удалось (${code}): ${message}`);
    console.error('Если это INPUT_INVALID «Сначала настройте облако» — TaskBridge ещё не перезапущен с новым config.json.');
    return 1;
  }
  await fsp.writeFile(LINK_FILE, `${result.body.url}\n`, 'utf8');
  console.log(result.body.url);
  console.log(`\nСсылка действует до ${new Date(result.body.expiresAt).toLocaleString('ru-RU')}. Откройте её на телефоне (мобильный интернет, не Wi-Fi).`);
  console.log('QR сканировать не обязательно: ссылку можно отправить себе в мессенджер.');
  console.log(`Сохранена: ${LINK_FILE}`);
  return 0;
}

// The tunnel is started through PowerShell (see spawnTunnel), so its real PID is
// not the one we recorded: the provider processes are found by command line.
function killTunnelProcesses() {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve([]);
    const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'tunnelmole|cloudflared|ngrok' -and $_.Name -ne 'powershell.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId }";
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true }, (error, stdout) => resolve(String(stdout || '').trim().split(/\s+/).filter(Boolean)));
  });
}

async function commandStop() {
  const pids = readJsonSafe(PIDS_FILE, {});
  const cloudStopped = killTree(pids.cloudPid);
  const tunnelStopped = await killTunnelProcesses();
  await writeJson(PIDS_FILE, {});
  console.log(`остановлено: облако=${cloudStopped}, туннели=${tunnelStopped.join(',') || 'нет'}`);
  console.log('config.json не тронут: чтобы ПК не стучался в мёртвое облако, поставьте cloud.enabled=false (экран ☁ или config.json) и перезапустите TaskBridge.');
  return 0;
}

// --- end-to-end check (a real relay client, over the public URL) ------------

function wsUrl(relayHint, publicUrl) {
  if (relayHint) return relayHint;
  const base = publicUrl || '';
  return `${base.replace(/^http/i, 'ws')}/api/relay`;
}

async function commandVerify(args) {
  if (args.delayMs > 0) {
    console.log(`Ждём ${Math.round(args.delayMs / 1000)} с (перезапуск TaskBridge)…`);
    await sleep(args.delayMs);
  }
  const checks = [];
  const add = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail: String(detail ?? '') }); };

  const serverUp = await waitFor('local server', async () => (await getJson(`http://127.0.0.1:${args.localPort}/api/health`, { timeoutMs: 3_000 })).status === 200, { timeoutMs: 120_000, intervalMs: 2_000 });
  add('сервер TaskBridge отвечает', serverUp, `http://127.0.0.1:${args.localPort}/api/health`);

  const debug = await getJson(`http://127.0.0.1:${args.localPort}/debug/cloud`).catch(() => null);
  add('облако включено на машине', debug?.body?.enabled === true, JSON.stringify(debug?.body ?? null));

  const state = readJsonSafe(STATE_FILE, {});
  const health = state.publicUrl ? await getJson(`${state.publicUrl}/api/health`, { timeoutMs: 10_000 }).catch(() => null) : null;
  add('облако видно из интернета', health?.status === 200 && health.body?.durable === true, `${state.publicUrl || '—'}/api/health → ${JSON.stringify(health?.body ?? null)}`);

  const pair = await getJson(`http://127.0.0.1:${args.localPort}/api/cloud/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `Проверка ${new Date().toISOString()}` })
  }).catch(error => ({ status: 0, body: { error: error.message, code: 'UNREACHABLE' } }));
  add('ссылка паринга выдаётся', pair.status === 200 && Boolean(pair.body?.url), pair.body?.url || `${pair.body?.code}: ${pair.body?.error}`);

  let relayOk = false;
  let requestOk = false;
  let requestDetail = '';
  if (pair.status === 200 && pair.body?.url) {
    const fragment = new URLSearchParams(String(pair.body.url).split('#')[1] || '');
    const machineId = fragment.get('m');
    const deviceToken = fragment.get('t');
    const url = wsUrl(fragment.get('r'), state.publicUrl);
    await fsp.writeFile(LINK_FILE, `${pair.body.url}\n`, 'utf8').catch(() => {});
    try {
      const result = await relayRoundTrip({ url, machineId, deviceToken });
      relayOk = result.authed;
      requestOk = result.requestOk;
      requestDetail = result.detail;
      if (result.authed && !result.machineOnline) requestDetail = `${result.detail} — ПК не на релее: перезапустите TaskBridge с cloud.realtime=true`;
    } catch (error) {
      requestDetail = error.message;
    }
  }
  add('релей принял это устройство (AUTH_OK)', relayOk, requestDetail);
  add('машина ответила на запрос через релей', requestOk, requestDetail);

  const passed = checks.filter(check => check.ok).length;
  const report = [
    '# Сценарий C: сквозная проверка через мобильный интернет',
    '',
    `Время: ${new Date().toISOString()}`,
    `Публичный адрес: ${state.publicUrl || '—'}`,
    '',
    `## Итог: ${passed}/${checks.length}`,
    '',
    '| Проверка | Результат | Детали |',
    '|---|---|---|',
    ...checks.map(check => `| ${check.name} | ${check.ok ? '✅' : '❌'} | ${check.detail.replaceAll('|', '\\|').slice(0, 300)} |`),
    '',
    passed === checks.length
      ? 'Телефон с мобильного интернета управляет ПК: путь телефон → https/туннель → локальное облако → релей → ПК проверен целиком.'
      : 'Путь не подтверждён — смотрите ❌ выше и логи data/cloud-local/.',
    ''
  ].join('\n');
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.writeFile(VERIFY_REPORT, report, 'utf8');
  console.log(report);
  console.log(`Отчёт: ${VERIFY_REPORT}`);
  return passed === checks.length ? 0 : 2;
}

// A real relay client: HELLO as a phone, then one REQUEST the machine answers.
// Nothing is mocked: this is the same WebSocket path the phone PWA uses.
function relayRoundTrip({ url, machineId, deviceToken, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const result = { authed: false, machineOnline: false, requestOk: false, detail: '' };
    const commandId = crypto.randomUUID();
    let done = false;
    const finish = error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(1000, 'done'); } catch { /* already closed */ }
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(`таймаут ${timeoutMs / 1000} с: ${result.detail || 'нет ответа'}`)), timeoutMs);
    socket.addEventListener('open', () => {
      socket.send(serializeEnvelope(createEnvelope({ type: 'HELLO', machineId, payload: { role: 'client', auth: { deviceToken } } })));
    });
    socket.addEventListener('message', event => {
      let frame;
      try { frame = parseEnvelope(String(event.data)); } catch { return; }
      if (frame.type === 'AUTH_OK') {
        result.authed = true;
        result.detail = `AUTH_OK role=${frame.payload?.role} deviceId=${frame.payload?.deviceId}`;
        socket.send(serializeEnvelope(createEnvelope({ type: 'REQUEST', machineId, commandId, payload: { method: 'GET', path: '/api/tasks' } })));
        return;
      }
      if (frame.type === 'AUTH_FAIL') return finish(new Error(`релей отклонил устройство: ${frame.payload?.code}`));
      if (frame.type === 'RESPONSE' && frame.commandId === commandId) {
        const body = frame.payload?.body;
        let count = null;
        try { count = Array.isArray(JSON.parse(body)) ? JSON.parse(body).length : null; } catch { count = null; }
        result.machineOnline = true;
        result.requestOk = frame.status === 'OK' && count !== null;
        result.detail = `RESPONSE status=${frame.status} httpStatus=${frame.payload?.httpStatus} задач=${count}`;
        return finish();
      }
      if (frame.type === 'ERROR' && (!frame.commandId || frame.commandId === commandId)) {
        // MACHINE_OFFLINE is the honest answer while the PC has not restarted
        // into its relay connector yet — not a broken tunnel.
        result.machineOnline = frame.payload?.code !== 'MACHINE_OFFLINE';
        result.detail = `ERROR ${frame.payload?.code}: ${frame.payload?.message}`;
        return finish();
      }
      if (frame.type === 'MACHINE_STATUS') result.detail = `MACHINE_STATUS online=${frame.payload?.online}`;
    });
    socket.addEventListener('error', () => { if (!result.authed) finish(new Error('не удалось открыть WebSocket с релеем')); });
    socket.addEventListener('close', () => { if (!result.requestOk) finish(new Error(result.detail || 'соединение закрыто')); });
  });
}

// One relay round trip through the public address, with a token minted here from
// creds.json — no running server and no pairing needed for this half.
function probeRelay({ creds, publicUrl, timeoutMs = 25_000 }) {
  const deviceId = `dev-probe${crypto.randomBytes(4).toString('hex')}`;
  const deviceToken = issueDeviceToken({ machineId: creds.machineId, deviceId, secret: creds.machineSecret });
  const url = `${publicUrl.replace(/^http/i, 'ws')}/api/relay`;
  return relayRoundTrip({ url, machineId: creds.machineId, deviceToken, timeoutMs });
}

// Proof that the public path works before touching TaskBridge: the relay accepts
// the device; whether the PC answers depends on its relay connector being up.
async function commandProbe(args) {
  const creds = await ensureCreds();
  const state = readJsonSafe(STATE_FILE, {});
  if (!state.publicUrl) throw new Error('Публичного адреса нет — сначала: npm run cloud:local -- start');
  const result = await probeRelay({ creds, publicUrl: state.publicUrl, timeoutMs: args.delayMs > 0 ? args.delayMs : 25_000 });
  console.log(JSON.stringify({ relay: `${state.publicUrl.replace(/^http/i, 'ws')}/api/relay`, machineId: creds.machineId, ...result }, null, 2));
  console.log(result.authed
    ? 'Релей через туннель принял устройство (путь телефон → https → облако → релей работает).'
    : 'Релей устройство не принял — смотрите detail выше и хвост data/cloud-local/tunnel.log.');
  if (result.authed && !result.machineOnline) console.log('ПК не на релее: проверьте, что в config.json realtime=true и TaskBridge перезапущен после этого.');
  return result.authed ? 0 : 1;
}

// --- main -------------------------------------------------------------------

async function main() {
  const raw = process.argv.slice(2);
  if (raw[0] === 'ngrok:setup') return ngrokSetup(raw[1]);
  const args = parseArgs(raw);
  if (args.command === 'start') return commandStart(args);
  if (args.command === 'status') return commandStatus(args);
  if (args.command === 'probe') return commandProbe(args);
  if (args.command === 'link') return commandLink(args);
  if (args.command === 'verify') return commandVerify(args);
  if (args.command === 'stop') return commandStop(args);
  console.error('Usage: node scripts/cloud-local.mjs start|status|probe|link|verify|stop|ngrok:setup [--port 8788] [--url https://…] [--tunnel cloudflared|tunnelmole|ngrok|none] [--domain <ngrok-static>] [--protocol http2] [--delay-ms N]');
  return 1;
}

// ngrok free: one-time paste of the dashboard authtoken, then find the single
// free static domain (dashboard → Your Domain) to get a *stable* public address.
//   npm run cloud:local -- ngrok:setup <TOKEN>
//   npm run cloud:local -- start --tunnel ngrok --domain my-name.ngrok-free.app
async function ngrokSetup(token) {
  if (!token) throw new Error('Укажите токен: npm run cloud:local -- ngrok:setup <TOKEN>');
  const npx = npxCommand();
  await new Promise((resolve, reject) => {
    const child = spawn(npx.file, ['--yes', 'ngrok@latest', 'config', 'add-authtoken', token], { shell: npx.shell, stdio: 'inherit', cwd: root });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`ngrok config add-authtoken → код ${code}`))));
  });
  console.log('Токен сохранён в конфиге ngrok. Осталось указать бесплатный статический домен:');
  console.log('  ngrok dashboard → Your Domain → скопируйте адрес вида abc-123.ngrok-free.app, затем:');
  console.log('  npm run cloud:local -- start --tunnel ngrok --domain <домен>');
  return 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
