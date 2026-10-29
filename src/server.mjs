import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { gzip } from 'node:zlib';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig } from './config.mjs';
import { deliveryMetrics } from './delivery-metrics.mjs';
import { memoryMetrics } from './memory/memory-metrics.mjs';
import { SseWriter } from './sse-writer.mjs';
import { sessionStorage, warnSessionBytes } from './session-storage.mjs';
import { WakeChannel } from './wake-channel.mjs';
import { autoRestartDecision, autoRestartConfigured, nextRestartAt, normalizeAutoRestart } from './auto-restart.mjs';
import { listDirectory, resolveBrowsablePath, resolveLocalProjectPath, listWorkspaceFiles } from './project-browser.mjs';
import { TaskStore } from './task-store.mjs';
import { TaskManager, briefTask } from './task-manager.mjs';
import { FollowPlanService } from './follow-plan-service.mjs';
import { AccessControl, lanAllowed, isTailnetIp, LAN_CLOSED_WARNING } from './auth.mjs';
import { contentType, containedExistingAncestor, containedFile, forbiddenFile, isPrivatePath, realpathNamed, serveFile, FILE_LIMITS } from './files.mjs';
import { openLocalPath, runLocalScript, runShellCommand } from './open-local.mjs';
import { tailBytes } from './tool-output.mjs';
import { RuntimeControl } from './runtime-control.mjs';
import { collectGitState } from './git.mjs';
import { ensureTlsCert } from './tls.mjs';
import { trimStreamingDeltas, lightenEvent } from './event-trim.mjs';
import { windowByTurns, capEventsByBytes } from './event-window.mjs';
import { multipartBoundary } from './multipart.mjs';
import { acquireInstanceLock } from './instance-lock.mjs';
import { resolveCloudConfig, validateCloudConfig } from './cloud/cloud-config.mjs';
import { CloudWorker } from './cloud/cloud-worker.mjs';
import { CloudClient } from './cloud/cloud-client.mjs';
import { secretFingerprint } from './cloud/machine-auth.mjs';
import { issueDeviceToken, DEFAULT_DEVICE_TOKEN_TTL_MS } from './cloud/device-token.mjs';
import { TrustedDevices, newDeviceId } from './cloud/trusted-devices.mjs';
import { createRelayConnector } from './cloud/relay-connector.mjs';
import { PushCenter, notificationFor } from './push/push-center.mjs';
import { createInvocationNotifier } from './automation/invocation-notifier.mjs';
import { buildMachineHeartbeat } from './domain/machine-state.mjs';
import { piAgentDir, readPiSettings, imagesBlocked } from './pi-settings.mjs';
import { PiProviderProfiles } from './providers/pi-provider-profiles.mjs';
import { listQuickActions } from './pi-quick-actions.mjs';
import { listProcesses, listGpuProcesses, gpuSummary, systemRam } from './process-info.mjs';
import { createCleanupPreview, executeCleanup, getCleanupResultByCommand, cleanupHistory } from './cleanup.mjs';
import { killProcess, killProcessesByRuntime } from './process-kill.mjs';
import { readSystemMetrics } from './system-metrics.mjs';
import { readProviderStatuses, readWormsoftStatus, readRouterAiStatus, readOpenAiCodexStatus } from './provider-status.mjs';
import { readDeepseekCost } from './deepseek-cost.mjs';
import { PiVersionProbe } from './pi-version.mjs';
import { resolvePiCommand, piRuntimeState } from './pi-command.mjs';
import { API_VERSION } from './api-contract.mjs';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const webDir = path.join(rootDir, 'web');
// TASKBRIDGE_DATA_DIR lets a second instance run without touching the operator's
// data (tests, acceptance harnesses, smoke runs next to a live server).
const dataRoot = process.env.TASKBRIDGE_DATA_DIR
  ? path.resolve(process.env.TASKBRIDGE_DATA_DIR)
  : path.join(rootDir, 'data');

// Identifies exactly which build/commit this running process was started
// from, so a stale-vs-fresh deploy is visible in the UI instead of guessed
// at. version is the human-facing number (bumped by hand per release); the
// commit is extra detail for debugging which exact code that number maps to.
const build = await (async () => {
  const version = await fs.readFile(path.join(rootDir, 'package.json'), 'utf8').then(text => JSON.parse(text).version, () => null);
  try {
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%h %cI'], { cwd: rootDir, windowsHide: true });
    const [commit, date] = stdout.trim().split(' ');
    return { version, commit: commit || null, date: date || null };
  } catch {
    return { version, commit: null, date: null };
  }
})();

const config = await loadConfig(rootDir);
const providerRefreshes = new Map();
const providerProfiles = new PiProviderProfiles({ agentDir: piAgentDir() });

// Identifies this process run, not the code it runs: every page keeps the bootId
// it first saw and reloads when it changes — that is how a phone tab (which has
// no restart flow of its own running) learns the machine was restarted behind
// its back and refreshes like the tab that pressed the button.
const bootId = crypto.randomUUID();

// Автоматический перезапуск: решение принимает src/auto-restart.mjs (чистые
// правила), исполняет — тот же воркер, что и кнопка. Оператору видно план:
// /api/info.autoRestart.nextAt и причина, по которой перезапуск отложен.
const serverStartedAt = Date.now();
const autoRestartConfig = normalizeAutoRestart(config.server?.autoRestart);
let lastAutoRestartAt = null;
let autoRestartState = { reason: 'idle', deferred: false };

// Variant B (docs/agent-host-separation.md §12): the app runs *behind* the LAN
// proxy, and the proxy owns the public face — address, port, TLS. These knobs
// keep the app loopback-only and let it print links that point at the proxy
// instead of at itself, without editing the user's config.json:
//   TASKBRIDGE_BIND_HOST      — bind loopback (the proxy is the only door)
//   TASKBRIDGE_PORT           — the port to listen on (the internal one)
//   TASKBRIDGE_PUBLIC_PORT    — the port the *proxy* listens on, for the UI's links
//   TASKBRIDGE_DISABLE_TLS=1  — TLS moves to the proxy, so the app must not open 8443
const bindHostOverride = process.env.TASKBRIDGE_BIND_HOST || null;
const portOverride = Number(process.env.TASKBRIDGE_PORT || 0) || null;
const publicPortOverride = Number(process.env.TASKBRIDGE_PUBLIC_PORT || 0) || null;
const tlsDisabled = process.env.TASKBRIDGE_DISABLE_TLS === '1';

await fs.mkdir(dataRoot, { recursive: true });
let instanceLock;
try {
  const internalPort = portOverride || Number(config.server?.port || 8787);
  const publicPort = publicPortOverride || internalPort;
  const mode = bindHostOverride === '127.0.0.1' && tlsDisabled && publicPortOverride ? 'lan' : 'monolith';
  instanceLock = acquireInstanceLock(dataRoot, { mode, internalPort, publicPort });
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exit(1);
}
process.on('exit', () => instanceLock.release());
const store = new TaskStore(dataRoot, {
  synchronous: config.server?.sqlite?.synchronous,
  busyTimeoutMs: config.server?.sqlite?.busyTimeoutMs
});
const manager = new TaskManager(config, dataRoot, store);
// Which Pi we drive, checked once at startup (B0). Reported by /api/info; an
// unsupported or missing Pi is a warning, never a startup failure.
// Тот же выбор команды, что и у сессий: иначе /api/info проверял бы не тот Pi.
const piCommand = resolvePiCommand({ config });
const piVersion = new PiVersionProbe({ command: piCommand.command, env: config.pi?.env || null });
piVersion.refresh().catch(() => {});
// The Pi approval extension needs a loopback endpoint and its absolute path.
manager.approvalBaseUrl = `http://127.0.0.1:${Number(config.server?.port || 8787)}`;
manager.approvalExtensionPath = path.join(rootDir, 'pi-extension', 'taskbridge-approval.js');
// Turn instructions in `hook` mode (CORE-02): the same extension directory the
// approval gate uses. A missing file fails the task loudly instead of sending a
// prompt without the rules (see TaskManager#createPi).
manager.turnInstructionsExtensionPath = path.join(rootDir, 'pi-extension', 'taskbridge-turn-instructions.js');
// Media policy: keeps base64 screenshots out of the request without touching the
// saved transcript (pi-extension/taskbridge-media.js).
manager.mediaExtensionPath = path.join(rootDir, 'pi-extension', 'taskbridge-media.js');
// Follow Plan checkpoint tool (FP-05A): only loaded when followPlan.enabled.
manager.followPlanExtensionPath = path.join(rootDir, 'pi-extension', 'taskbridge-follow-plan.js');
await manager.init();
// Follow Plan (PLAN-FOLLOW-01, FP-05A): a controller over the dispatch that
// already exists. The flag stays off until the FP-06 acceptance; with it off the
// control routes refuse and nothing generates on its own.
const followPlan = new FollowPlanService({
  manager, store, config,
  // Optional AI check (FP-UX-04E): a plain question to the session's model, no
  // tools and no Run. Absent → the button reports «недоступно» and attach works.
  askModel: typeof manager.askModelOnce === 'function' ? input => manager.askModelOnce(input) : null
});
manager.setFollowPlanHooks({
  turnSettled: input => followPlan.turnSettled(input),
  // A failed turn (403/413/… or a cancelled one) settles nothing: the plan pauses.
  turnFailed: input => followPlan.turnFailed(input),
  // The next step is sent only after the previous turn's terminal event is durable.
  turnCommitted: input => followPlan.turnCommitted(input)
});
if (followPlan.enabled) {
  // Nothing is re-sent after a restart: a dispatched-but-unsettled cycle pauses.
  followPlan.recoverAll().catch(error => console.error(`[TaskBridge] Follow Plan recovery failed: ${error.message}`));
}
// Router mode is meant to be always-on: the process is a cheap supervisor that
// only loads models on demand. Start it eagerly so the model picker and the UI
// can discover local models right away; a failure must not stop the server.
if (manager.localModels.enabled) {
  manager.startLocal().catch(error => console.error(`[TaskBridge] Router start failed: ${error.message}`));
}

// Checkpoint and close SQLite cleanly on Ctrl+C instead of leaving a WAL tail.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await cloudWorker?.stop(); } catch {}
    try { await relayConnector?.stop(); } catch {}
    // Close the agent side gracefully (Pi sessions + router) so shutdown does
    // not leave an orphaned Pi or a lingering llama.cpp, and so an active task
    // is not ripped away mid-turn without an explanation. Bounded by a hard
    // timeout so Ctrl+C always exits even if a process refuses to die.
    try { await Promise.race([manager.close(), new Promise(r => setTimeout(r, 6000))]); } catch {}
    try { store.close(); } catch {}
    process.exit(0);
  });
}
const access = new AccessControl(config.server?.auth, dataRoot);
await access.init();
const runtimeControl = new RuntimeControl(manager.runtimeManager, manager);
// AUTO dispatcher switches the managed model profile by restarting the runtime.
manager.runtimeSwitcher = profileId => runtimeControl.restart(profileId);
const httpsConfig = config.server?.https || {};

// Optional cloud control plane (§6, §11, §90). Local-only mode is the default
// and must keep working with no Vercel dependency at all.
let cloudConfig = resolveCloudConfig(config, process.env, { dataRoot });
let cloudCheck = validateCloudConfig(cloudConfig);
let cloudWorker = null;
let relayConnector = null;
// Which phones may reach this machine (pairing, § cloud-protocol.md). Revocation
// has to be enforced here: a device token is a stateless signature the relay
// cannot take back.
const trustedDevices = await new TrustedDevices(dataRoot).load();
// Web Push (§ notifications): the machine is its own application server, so a
// finished session reaches the phone even with the PWA closed — and the text is
// encrypted for that phone alone, with no cloud in the path.
const push = await new PushCenter(dataRoot).load();

// Resolves the effective cloud configuration from config.json + environment,
// validates it and (re)starts the worker. Used at boot and when the settings
// screen saves a new configuration (§91).
async function applyCloudConfig({ quiet = false } = {}) {
  if (cloudWorker) {
    await cloudWorker.stop().catch(() => {});
    cloudWorker = null;
  }
  if (relayConnector) {
    await relayConnector.stop().catch(() => {});
    relayConnector = null;
  }
  cloudConfig = resolveCloudConfig(config, process.env, { dataRoot });
  cloudCheck = validateCloudConfig(cloudConfig);
  if (!cloudConfig.enabled) return { enabled: false, problems: [] };
  if (!cloudCheck.ok) {
    console.error(`[TaskBridge] cloud transport disabled: ${cloudCheck.problems.join('; ')}`);
    return { enabled: false, problems: cloudCheck.problems };
  }
  const aliases = {};
  for (const project of config.projects || []) {
    const alias = String(project.id || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    if (alias && project.path) aliases[alias] = project.path;
  }
  cloudWorker = new CloudWorker({
    config: cloudConfig,
    manager,
    store,
    dataRoot,
    version: build.version,
    aliases
  });
  cloudWorker.start().catch((error) => {
    console.error(`[TaskBridge] cloud transport failed to start: ${error.message}`);
  });
  // The realtime path: the machine dials the relay itself, so the shared UI on a
  // phone reaches this API without an inbound port. Off by default — polling
  // through the cloud API stays authoritative until an operator turns it on.
  if (cloudConfig.realtime && cloudConfig.relayUrl) {
    relayConnector = createRelayConnector({
      url: cloudConfig.relayUrl,
      machineId: cloudConfig.machineId,
      machineSecret: cloudConfig.machineSecret,
      manager,
      dispatcher: cloudWorker.dispatcher,
      store,
      localApiBase: `http://127.0.0.1:${Number(config.server?.port || 8787)}`,
      // A revoked phone is refused here, frame by frame, and a live one keeps
      // its "last seen" fresh for the devices screen.
      isDeviceAllowed: (deviceId) => {
        if (!deviceId) return false;
        if (!trustedDevices.allowed(deviceId)) return false;
        trustedDevices.touch(deviceId);
        return true;
      }
    });
    relayConnector.start().catch((error) => {
      console.error(`[TaskBridge] relay connector failed to start: ${error.message}`);
    });
    if (!quiet) console.log(`[TaskBridge] relay: ${cloudConfig.relayUrl}`);
  }
  if (!quiet) console.log(`[TaskBridge] cloud transport enabled: ${cloudConfig.url} as ${cloudConfig.machineId}`);
  return { enabled: true, problems: [] };
}
await applyCloudConfig();

const sseClients = new Map();

// Фаза 4: эпизоды DEGRADED у клиентов. Обрыв связи раньше замечает клиент (у него
// двухуровневый health: сервер отвечает, поток молчит), поэтому сервер не может
// вычислить это сам — клиент сообщает переходы. Считаем ИМЕННО переходы, а не
// каждый ретрай: клиент повторяет попытки, и счёт по попыткам мерил бы шум.
const clientLinks = new Map();
const CLIENT_LINK_LIMIT = 200;
let linkEpisodes = { degraded: 0, recovered: 0, lastDegradedAt: null };

function noteClientLink(req, body) {
  const state = String(body?.state || '');
  if (!['live', 'degraded', 'reconnecting'].includes(state)) {
    throw Object.assign(new Error('state — один из: live, degraded, reconnecting.'), { code: 'INPUT_INVALID' });
  }
  const clientId = String(body?.clientId || '').trim().slice(0, 64) || req.socket?.remoteAddress || 'unknown';
  const at = new Date().toISOString();
  const previous = clientLinks.get(clientId);
  const wasLive = !previous || previous.state === 'live';
  if (state !== 'live' && wasLive) {
    linkEpisodes.degraded += 1;
    linkEpisodes.lastDegradedAt = at;
  } else if (state === 'live' && !wasLive) {
    linkEpisodes.recovered += 1;
  }
  clientLinks.set(clientId, {
    state,
    // since — начало ТЕКУЩЕГО состояния, а не время последнего сообщения: иначе
    // долгий обрыв выглядел бы как только что начавшийся.
    since: previous && previous.state === state ? previous.since : at,
    at,
    reason: body?.reason ? String(body.reason).slice(0, 200) : null,
    attempt: Number.isFinite(body?.attempt) ? Number(body.attempt) : null,
  });
  if (clientLinks.size > CLIENT_LINK_LIMIT) {
    // Ограничение памяти: выкидываем запись с самым старым касанием.
    const oldest = [...clientLinks.entries()].sort((a, b) => String(a[1].at).localeCompare(String(b[1].at)))[0];
    if (oldest) clientLinks.delete(oldest[0]);
  }
  return { clientId, state, since: clientLinks.get(clientId).since };
}

function clientLinkHealth() {
  const entries = [...clientLinks.entries()].map(([clientId, value]) => ({ clientId, ...value }));
  return {
    degradedEpisodes: linkEpisodes.degraded,
    recoveredEpisodes: linkEpisodes.recovered,
    lastDegradedAt: linkEpisodes.lastDegradedAt,
    degradedClients: entries.filter(entry => entry.state !== 'live')
      .map(entry => ({ clientId: entry.clientId, state: entry.state, since: entry.since, reason: entry.reason, attempt: entry.attempt })),
  };
}

// A single request must not materialize an unbounded history in memory. Older
// pages are reached with ?tail/?before; this is the hard ceiling per request.
const maxEventsPerRequest = Math.min(Math.max(Number(config.server?.maxEventsPerRequest || 20000), 1), 200000);
// Hard ceiling on one history response body. A window is bounded by turns, but a
// turn can be tens of megabytes; sending that freezes the browser while it
// parses. Overridable with server.maxHistoryMb.
const maxHistoryBytes = Math.min(Math.max(Number(config.server?.maxHistoryMb || 6) * 1024 * 1024, 256 * 1024), 64 * 1024 * 1024);
// What one history page weighs on the wire (+1 per event, the newline the reader
// splits on): the same arithmetic capEventsByBytes uses, so "the budget could not
// fit this page" is measured the same way as "the budget fits this page".
const pageBytes = (events) => events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event), 'utf8') + 1, 0);

function addSseClient(taskId, res, cursor = 0) {
  const client = {
    taskId, res, cursor, pending: [], replaying: true,
    // Шаг C-B: запись с учётом backpressure. Медленный клиент ставится на паузу,
    // а не копит события в памяти без предела; на переполнении стрим обрывается
    // и клиент переподключается по своему курсору (события есть в store).
    writer: new SseWriter(res, { onOverflow: () => sseClients.get(taskId)?.delete(client) })
  };
  if (!sseClients.has(taskId)) sseClients.set(taskId, new Set());
  sseClients.get(taskId).add(client);
  res.on('close', () => sseClients.get(taskId)?.delete(client));
  return client;
}

function deliver(client, event) {
  if (event.seq <= client.cursor) return true;
  // Событие принято в сокет или в очередь на 'drain'; при обрыве клиент уже
  // убран из фан-аута, и его хвост придёт из store при переподключении.
  if (!client.writer.send(event)) {
    // Фаза 4: обрыв стрима — заметная метрика, а не тихая строка кода: рост
    // этого счётчика означает, что клиенты не успевают за сервером.
    deliveryMetrics.increment('sse_stream_dropped');
    return false;
  }
  client.cursor = event.seq;
  return true;
}

manager.on('task-event', (event) => {
  // Шаг C-C: лаг «событие создано → публикация в SSE». Включает запись в store
  // (#recordEvent пишет в БД до emit) и доходит до фан-аута — рост этой цифры
  // при живом Pi означает, что отстаёт серверная публикация, а не модель.
  const createdAt = Date.parse(event.at);
  if (Number.isFinite(createdAt)) deliveryMetrics.observe('sse_publish_lag_ms', Math.max(0, Date.now() - createdAt));
  for (const client of sseClients.get(event.taskId) || []) {
    if (client.replaying) client.pending.push(event);
    else try { deliver(client, event); } catch {}
  }
  // Sample after a completed Pi turn (initial prompt AND follow-ups), so the
  // remainder includes that request's usage. Fire-and-forget; rapid turns
  // share the provider cache (at most one read per minute).
  if (event.type === 'PI_EVENT' && event.data?.pi?.type === 'agent_settled'
      && manager.getTask?.(event.taskId)?.model?.provider === 'wormsoft') {
    readWormsoftStatus(config.providerStatus?.wormsoft, {
      env: process.env,
      storagePath: path.join(dataRoot, 'wormsoft-usage.json'),
      // Sampling keeps its own one-minute floor instead of the display cache
      // TTL: a balance read must include this request's usage even if the
      // panel was refreshed a moment ago.
      noCache: true,
      minRefreshMs: 60_000,
    }).catch(() => {});
  }
  // Only what an operator waits for (finished, failed, needs a confirmation).
  const notification = notificationFor(event, manager.getTask?.(event.taskId));
  if (notification) push.notify(notification).catch(() => {});
});

// The scheduler tick (MR-06). One timer for the whole machine, and a tick that can
// run late without starting a run twice: the decision is recorded per invocation,
// and the schedule's next moment is advanced with it.
// `schedules`, not `scheduler`: the latter already means the session-queue scheduler in
// /api/info and in the docs, and two different things under one name is how a
// configuration mistake gets made.
// Итоговые уведомления автоматизаций (AUTO-03C). Событие сессии молчит, пока идёт
// обязательная проверка, поэтому финальное уведомление отправляется здесь — когда
// сверка перевела инвокацию в терминальное состояние. Решение и дедупликация — в
// src/automation/invocation-notifier.mjs (её проверяет приёмка AUTO-03E).
const notifyFinishedInvocations = createInvocationNotifier({ manager, push });

const schedulerConfig = config.schedules || {};
if (schedulerConfig.enabled !== false) {
  const tickSec = Math.min(Math.max(Number(schedulerConfig.tickSec) || 30, 5), 3600);
  const tick = () => manager.schedulerTick()
    .then(result => notifyFinishedInvocations(result?.reconciled ?? []))
    .catch((error) => {
      console.error(`scheduler tick failed: ${error.message}`);
    });
  // The first tick waits one interval: startup is not the moment for a backlog.
  const schedulerTimer = setInterval(tick, tickSec * 1000);
  schedulerTimer.unref?.();
  process.on('exit', () => clearInterval(schedulerTimer));
}

// Автоматический перезапуск по таймеру (запрос оператора 2026-10-14). По умолчанию
// выключен: config.server.autoRestart.enabled = true включает. Решение — в
// src/auto-restart.mjs, исполнение — triggerRestart, тот же путь, что у кнопки.
if (autoRestartConfigured(autoRestartConfig)) {
  const tick = async () => {
    const decision = autoRestartDecision(autoRestartConfig, {
      startedAt: serverStartedAt,
      lastRestartAt: lastAutoRestartAt,
      // Живая работа: при onlyWhenIdle перезапуск откладывается, а не обрывает ход —
      // оператор ставит таймер, чтобы сервер поднялся свежим, а не чтобы потерять ответ.
      // Считаем и очередь промптов: она живёт в памяти, и рестарт её теряет (A5).
      active: manager.hasPendingWork(),
    });
    autoRestartState = { reason: decision.reason, deferred: decision.deferred === true };
    if (!decision.restart) return;
    lastAutoRestartAt = Date.now();
    try {
      await triggerRestart({ reason: 'timer' });
    } catch (error) {
      console.error(`[restart] timer restart failed: ${error.message}`);
      autoRestartState = { reason: 'failed', error: error.message };
    }
  };
  const autoTimer = setInterval(() => { tick().catch(() => {}); }, autoRestartConfig.tickSec * 1000);
  autoTimer.unref?.();
  process.on('exit', () => clearInterval(autoTimer));
}

// R2.5: a client counts the stream dead after 3 silent intervals.
setInterval(() => {
  for (const clients of sseClients.values()) {
    for (const client of clients) {
      try { client.res.write(': heartbeat\n\n'); } catch {}
    }
  }
}, Math.min(Math.max(Number(config.server?.sse?.heartbeatSec) || 15, 1), 300) * 1000).unref();

// Abandoned uploads are only referenced by a token the client may never use.
setInterval(() => manager.uploads.cleanup().catch(() => {}), 30 * 60 * 1000).unref();

// Сжатие JSON-ответов. Причина конкретная: список сессий — первое, что грузит
// телефон, и он тянет его каждые 5 с; без сжатия это было 1.1 МБ по Wi-Fi на
// ~50 КБ/с, и список «тормозил» десятками секунд (2026-10-14). JSON с
// повторяющимися ключами сжимается в 5–8 раз, прозрачно для всех клиентов
// (OkHttp и браузеры распаковывают сами; прокси пробрасывает content-encoding).
const COMPRESS_MIN_BYTES = 1024;

function json(res, status, body) {
  const buffer = Buffer.from(JSON.stringify(body, null, 2), 'utf8');
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  // res.req — тот же запрос, что привёл сюда; заголовок читается без правок в
  // сорока вызовах json(...).
  const accept = String(res.req?.headers?.['accept-encoding'] || '');
  if (buffer.length < COMPRESS_MIN_BYTES || !accept.includes('gzip')) {
    res.writeHead(status, { ...headers, 'content-length': buffer.length });
    res.end(buffer);
    return;
  }
  gzip(buffer, (error, zipped) => {
    // Ответ не должен теряться из-за сжатия: при любой ошибке уходит как есть.
    if (error || res.headersSent) {
      try {
        res.writeHead(status, { ...headers, 'content-length': buffer.length });
        res.end(buffer);
      } catch { /* соединение уже закрыто */ }
      return;
    }
    res.writeHead(status, {
      ...headers,
      'content-encoding': 'gzip',
      'content-length': zipped.length,
      'vary': 'accept-encoding'
    });
    res.end(zipped);
  });
}

function errorJson(res, status, error) {
  json(res, status, {
    error: error.message || String(error),
    code: error.code || 'INTERNAL_ERROR',
    // A few refusals are informative: which fields of the preview no longer match
    // (MR-04) — «context changed» alone tells the operator nothing to do.
    ...(Array.isArray(error.changes) ? { changes: error.changes } : {}),
    // Which deterministic checks refused a memory suggestion (MEM-08): «нельзя»
    // без перечня причин бесполезно — оператору нужно знать, что именно исправить.
    ...(Array.isArray(error.problems) ? { problems: error.problems } : {}),
    // Which process in the tree triggered the refusal (PROC-02).
    ...(Number.isInteger(error.protectedPid) ? { protectedPid: error.protectedPid } : {})
  });
}

async function readJson(req) {
  const maxBytes = Number(config.server?.maxBodyMb || 25) * 1024 * 1024;
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error(`Request body exceeds ${config.server?.maxBodyMb || 25} MB`);
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  if (buffer.length === 0) return {};
  // A body that is not valid UTF-8 is a client mistake: `toString('utf8')` would
  // quietly turn the bad bytes into U+FFFD and hand the endpoint a body nobody
  // sent. Node's fetch makes this easy to hit by passing an object instead of a
  // string (`JSON.stringify` never ran → "[object Object]" bytes through).
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw Object.assign(new Error('Тело запроса не является корректным UTF-8.'), { code: 'INPUT_INVALID' });
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    // Malformed JSON used to fall through to the generic handler: it answered
    // 500 INTERNAL_ERROR with the parser's own words and made a client mistake
    // look like a server fault (2026-10-21). The parser message stays in the
    // server log; the client gets the contract's INPUT_INVALID.
    throw Object.assign(new Error('Тело запроса не является корректным JSON.'), { code: 'INPUT_INVALID' });
  }
}

// How this process was started, so a restart relaunches the same shape. LAN mode
// runs an app + proxy pair (scripts/start-lan.mjs) and writes data/lan.json; a
// bare `node src/server.mjs` is the monolith.
async function detectServerMode() {
  try {
    const state = JSON.parse(await fs.readFile(path.join(dataRoot, 'lan.json'), 'utf8'));
    if (state && Number(state.appPid) === process.pid) return 'lan';
  } catch { /* no LAN state: monolith */ }
  return 'monolith';
}

// A task's Pi process env names this session, its approval endpoint and its task
// id; those must never leak into the restarted server.
function restartEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (['PI_SESSION_FILE', 'TASKBRIDGE_TASK_ID'].includes(key) || key.startsWith('TASKBRIDGE_APPROVAL_')) delete env[key];
  }
  return env;
}

// Единственная точка перезапуска: и кнопка, и таймер идут одним путём — иначе
// поведение двух механизмов разошлось бы (и «перезапуск по таймеру» оказался бы
// другим перезапуском).
async function triggerRestart({ reason = 'manual', delayMs = 1500 } = {}) {
  const mode = await detectServerMode();
  const script = mode === 'lan' ? 'scripts/restart-lan-now.mjs' : 'scripts/restart-and-verify.mjs';
  const args = mode === 'lan' ? [script, `--delay-ms=${delayMs}`] : [script, `--delay-ms=${delayMs}`, `--port=${port}`];
  console.log(`[restart] triggering (${reason}), mode=${mode}`);
  const pid = await launchRestartWorker(args);
  return { mode, pid };
}

// Wait for the intermediate launcher to exit before accepting the restart.
// `detached` alone does not leave a Windows process tree; if taskkill /T runs
// while that launcher is still a descendant, it kills the restart worker after
// stop and leaves no process to perform start.
function launchRestartWorker(args) {
  const launcher = spawn(process.execPath, [
    path.join(__dirname, 'orphan-launcher.mjs'),
    process.execPath,
    rootDir,
    ...args,
  ], {
    cwd: rootDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...restartEnv(), TASKBRIDGE_RESTART_ORPHAN: '1' },
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, pid) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(pid);
    };
    launcher.stdout.on('data', chunk => { stdout += String(chunk); });
    launcher.stderr.on('data', chunk => { stderr += String(chunk); });
    launcher.once('error', error => finish(error));
    launcher.once('close', code => {
      const pid = Number(/^\s*(\d+)/u.exec(stdout)?.[1]);
      if (code === 0 && Number.isSafeInteger(pid) && pid > 0) finish(null, pid);
      else finish(new Error(`Не удалось отделить процесс перезапуска${stderr.trim() ? `: ${stderr.trim()}` : '.'}`));
    });
    const timer = setTimeout(() => {
      launcher.kill();
      finish(new Error('Процесс запуска перезапуска не отделился за 5 с.'));
    }, 5000);
  });
}

function uniqueProjectId(manager, name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
  let id = base;
  for (let n = 2; manager.projects.has(id); n++) id = `${base}-${n}`;
  return id;
}

function lanAddresses(port, scheme = 'http') {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        out.push({ interface: name, ip: addr.address, kind: isTailnetIp(addr.address) ? 'tailnet' : 'lan', url: `${scheme}://${addr.address}:${port}` });
      }
    }
  }
  return out;
}

// R1.7: what the phone scans. Plain http endpoints only — the phone app talks
// to the tailnet IP directly (D5); `tailnet-https` is the browser's way in via
// `tailscale serve`, known only from config.
function pairingQr(pairing) {
  const tailscale = config.server?.tailscale || {};
  const endpoints = lanOpen ? lanAddresses(publicPort).map(({ kind, url }) => ({ kind, url })) : [];
  if (tailscale.ip && !endpoints.some(item => item.url === `http://${tailscale.ip}:${publicPort}`)) {
    endpoints.push({ kind: 'tailnet', url: `http://${tailscale.ip}:${publicPort}` });
  }
  if (tailscale.httpsUrl) endpoints.push({ kind: 'tailnet-https', url: String(tailscale.httpsUrl).replace(/\/+$/, '') });
  // Tailnet first: it works both at home and away.
  endpoints.sort((a, b) => (a.kind === 'lan') - (b.kind === 'lan'));
  return { v: 1, name: os.hostname(), endpoints, pairingCode: pairing.code, expiresAt: new Date(pairing.expiresAt).toISOString() };
}

async function serveStatic(urlPath, res) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.resolve(webDir, relative);
  const shell = path.join(path.resolve(webDir), 'index.html');
  if (!target.startsWith(path.resolve(webDir) + path.sep) && target !== shell) {
    return false;
  }
  const send = async (file) => {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-cache' });
    res.end(data);
    return true;
  };
  try {
    return await send(target);
  } catch {
    // Client routes such as /session/<id> are not files on disk: hand them the
    // SPA shell so a reload, a bookmark or a phone link opens the same session.
    // API callers keep their own JSON 404 instead of receiving HTML.
    if (urlPath !== '/' && !path.extname(urlPath) && !urlPath.startsWith('/api/')) {
      try { return await send(shell); } catch { return false; }
    }
    return false;
  }
}

async function listArtifacts(taskId) {
  const dir = path.join(store.taskDir(taskId), 'artifacts');
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => e.name);
}

// Only a bounded tail of a command's output is sent to the browser. A larger
// run does not flood the chat: the full text is written to the session's
// artifacts (so it shows up there and can be opened or copied later) and the
// reply carries the tail plus a reference to it.
// The workspace-file path lives in the query string (as the GET route reads it);
// a body value is accepted for an older client. Empty is an error, never "the
// workspace folder" — that silent fallback is what opened the folder.
function workspacePathQuery(url, body) {
  const requested = String(url.searchParams.get('path') || body?.path || '');
  if (!requested) throw Object.assign(new Error('Не указан файл.'), { code: 'INPUT_INVALID' });
  return requested;
}

const observedPathFields = ['path', 'file_path', 'filePath'];
const comparablePath = value => path.resolve(String(value)).replaceAll('\\', '/').toLowerCase();
/** Текст кадра — не путь: сравнивать его со путём можно только вхождением. */
const comparableText = value => String(value).replaceAll('\\', '/').toLowerCase();

function* observedToolPathValues(value) {
  if (!value || typeof value !== 'object') return;
  const args = (value.args && typeof value.args === 'object') ? value.args
    : (value.arguments && typeof value.arguments === 'object') ? value.arguments
      : null;
  if (args) {
    for (const field of observedPathFields) {
      if (typeof args[field] === 'string') yield args[field];
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* observedToolPathValues(item);
    return;
  }
  for (const item of Object.values(value)) yield* observedToolPathValues(item);
}

/**
 * Все строки кадра: текст ответа агента, команда, вывод инструмента.
 *
 * Зачем: чат показывает эти пути оператору — в ответе, в карточке команды, в выводе
 * поиска. Нажатие по такому пути должно открывать файл, а не отвечать «выходит за
 * пределы рабочей папки»: до 2026-10-12 открыть вне рабочей папки можно было только
 * файл, который агент передал *аргументом* инструмента, и половина путей из ответов
 * оставалась недоступной.
 */
function* observedTextValues(value) {
  if (typeof value === 'string') {
    yield value;
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) yield* observedTextValues(item);
    return;
  }
  for (const item of Object.values(value)) yield* observedTextValues(item);
}

const outsideWorkspace = () => Object.assign(new Error('Путь выходит за пределы рабочей папки.'), { code: 'INPUT_INVALID' });

/** Файл существует и он файл; иначе — честная ошибка вместо «выходит за пределы». */
async function observedFilePath(requestedPath) {
  // Bash-запись диска («/f/…» для «F:\…») — второе прочтение того же имени: агент
  // называет файлы так, и чат показывает их дословно.
  const resolved = await realpathNamed(requestedPath);
  if (!resolved) throw Object.assign(new Error('Файл не найден в рабочей папке — возможно, его удалили или переместили.'), { code: 'NOT_FOUND' });
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw Object.assign(new Error('Файл не найден.'), { code: 'NOT_FOUND' });
  return resolved;
}

const LINE_VIEW_MAX_BYTES = 4 * 1024 * 1024;
const LINE_VIEW_MAX_LINES = 2000;

function lineRangeParams(url) {
  const fromRaw = url.searchParams.get('from');
  const toRaw = url.searchParams.get('to');
  if (fromRaw === null && toRaw === null) return null;
  const from = Math.max(1, Number.parseInt(fromRaw || '1', 10) || 1);
  const requestedTo = Number.parseInt(toRaw || '', 10);
  const to = Number.isFinite(requestedTo) && requestedTo >= from ? requestedTo : from + LINE_VIEW_MAX_LINES - 1;
  return { from, to: Math.min(to, from + LINE_VIEW_MAX_LINES - 1) };
}

async function serveFileLineRange(res, target, name, range) {
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw Object.assign(new Error('Файл не найден.'), { code: 'NOT_FOUND' });
  if (stat.size > LINE_VIEW_MAX_BYTES) {
    throw Object.assign(new Error(`Файл слишком большой для просмотра по строкам (${Math.ceil(stat.size / 1048576)} MiB). Скачайте его целиком.`), { code: 'BODY_TOO_LARGE' });
  }
  const text = await fs.readFile(target, 'utf8');
  const lines = text.split(/\r?\n/u);
  const from = Math.min(Math.max(1, range.from), Math.max(1, lines.length));
  const to = Math.min(Math.max(from, range.to), lines.length);
  const body = lines.slice(from - 1, to).join('\n');
  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'content-disposition': `inline; filename="${path.basename(name).replace(/[^\x20-\x7e]|["\\]/g, '_')}"`,
    'x-taskbridge-lines-from': String(from),
    'x-taskbridge-lines-to': String(to),
    'x-taskbridge-lines-total': String(lines.length),
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
  });
  res.end(body);
}

async function observedToolFile(taskId, requestedPath, workspacePath = null) {
  // Секрет остаётся секретом и когда сессия его назвала: причина отказа называется
  // точно, а не «путь вне рабочей папки» — это разные вещи для оператора.
  if (isPrivatePath(requestedPath)) throw forbiddenFile();
  if (!path.isAbsolute(requestedPath)) throw outsideWorkspace();
  const requested = comparablePath(requestedPath);
  const events = await store.readEvents(taskId, 0);
  for (const event of events) {
    // Путь, названный аргументом инструмента. Относительный считается от рабочей папки
    // задачи, а не от каталога сервера: агент называет файлы относительно неё.
    for (const value of observedToolPathValues(event)) {
      if (!value || isPrivatePath(value)) continue;
      const absolute = path.isAbsolute(value) ? value : (workspacePath ? path.resolve(workspacePath, value) : null);
      if (!absolute || comparablePath(absolute) !== requested) continue;
      return observedFilePath(requestedPath);
    }
    // Путь, названный в самом кадре — в ответе, команде или выводе инструмента.
    for (const text of observedTextValues(event)) {
      if (!comparableText(text).includes(requested)) continue;
      return observedFilePath(requestedPath);
    }
  }
  throw outsideWorkspace();
}

const SHELL_PREVIEW_BYTES = 16 * 1024;
async function boundShellOutput(result, taskId) {
  const total = Buffer.byteLength(result.stdout, 'utf8') + Buffer.byteLength(result.stderr, 'utf8');
  if (total === 0) return { ...result, truncated: false };
  // The whole output is always kept as a file, not only when it is long: the
  // operator can then download it or attach it to a message instead of pasting
  // a wall of text into the composer. Only the preview sent to the browser is
  // bounded (a tail) once the run is large.
  const full = result.stderr ? `${result.stdout}\n--- stderr ---\n${result.stderr}` : result.stdout;
  const name = `cmd-output-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  await store.writeArtifact(taskId, name, full);
  const truncated = total > SHELL_PREVIEW_BYTES;
  return {
    ...result,
    stdout: truncated ? tailBytes(result.stdout, SHELL_PREVIEW_BYTES) : result.stdout,
    stderr: truncated ? tailBytes(result.stderr, SHELL_PREVIEW_BYTES) : result.stderr,
    truncated,
    outputName: name,
    outputBytes: Buffer.byteLength(full, 'utf8')
  };
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const pathname = decodeURIComponent(url.pathname);
    access.checkOrigin(req);
    if (req.method === 'GET' && pathname === '/api/auth') return json(res, 200, { authenticated: access.authenticated(req), enabled: access.enabled, local: access.local(req), machine: access.machine(req), deviceTokens: true, device: access.device(req) ? { deviceId: access.device(req).deviceId, kind: access.device(req).kind } : null });
    if (req.method === 'POST' && pathname === '/api/auth/pair') {
      const body = await readJson(req);
      const paired = await access.pair(req, res, body);
      // A browser keeps the token as an HttpOnly cookie only; a native client
      // (it says what it is) gets it once, here, for its Authorization header.
      const native = paired && ['android', 'desktop', 'cli'].includes(body.clientKind);
      return json(res, 200, { ok: true, ...(paired ? { deviceId: paired.deviceId } : {}), ...(native ? { token: paired.token } : {}) });
    }
    if (req.method === 'GET' && pathname === '/api/auth/pairing') {
      if (!access.enabled || !access.local(req)) return errorJson(res, 403, new Error('Код доступен только на компьютере через localhost.'));
      const pairing = access.pairing();
      return json(res, 200, { ...pairing, qr: pairingQr(pairing) });
    }
    if (req.method === 'GET' && pathname === '/api/auth/devices') {
      access.require(req);
      const current = access.device(req)?.deviceId || null;
      return json(res, 200, { devices: access.listDevices().map(device => ({ ...device, current: device.deviceId === current })) });
    }
    {
      const match = pathname.match(/^\/api\/auth\/devices\/([^/]+)$/);
      if (match && req.method === 'DELETE') {
        if (!access.enabled || !access.local(req)) return errorJson(res, 403, Object.assign(new Error('Отзывать устройства можно только с компьютера.'), { code: 'FORBIDDEN' }));
        await access.removeDevice(decodeURIComponent(match[1]));
        return json(res, 200, { ok: true });
      }
    }
    // --- cloud settings screen (§91) -----------------------------------------
    if (req.method === 'GET' && pathname === '/api/cloud/config') {
      const saved = config.cloud || {};
      const envLocked = ['TASKBRIDGE_CLOUD_ENABLED', 'TASKBRIDGE_CLOUD_URL', 'TASKBRIDGE_MACHINE_ID', 'TASKBRIDGE_MACHINE_SECRET']
        .filter(key => process.env[key]);
      return json(res, 200, {
        enabled: cloudConfig.enabled,
        url: cloudConfig.url,
        machineId: cloudConfig.machineId,
        machineDisplayName: cloudConfig.machineDisplayName || '',
        authMode: cloudConfig.authMode,
        hasSecret: Boolean(cloudConfig.machineSecret),
        secretFingerprint: cloudConfig.machineSecret ? secretFingerprint(cloudConfig.machineSecret) : null,
        realtime: cloudConfig.realtime,
        eventFlushMs: cloudConfig.eventFlushMs,
        eventBatchMax: cloudConfig.eventBatchMax,
        heartbeatSeconds: cloudConfig.heartbeatSeconds,
        idlePollSeconds: cloudConfig.idlePollSeconds,
        activePollSeconds: cloudConfig.activePollSeconds,
        maxOutboxMb: cloudConfig.maxOutboxMb,
        redactPaths: cloudConfig.redactPaths,
        protocolVersion: cloudConfig.protocolVersion,
        envLocked,
        saved: {
          enabled: Boolean(saved.enabled),
          url: saved.url || '',
          machineId: saved.machineId || '',
          machineDisplayName: saved.machineDisplayName || '',
          hasSecret: Boolean(saved.machineSecret)
        }
      });
    }

    if (req.method === 'POST' && pathname === '/api/cloud/config') {
      const body = await readJson(req);
      const next = { ...(config.cloud || {}) };
      if ('enabled' in body) next.enabled = Boolean(body.enabled);
      if ('url' in body) next.url = String(body.url || '').trim();
      if ('machineId' in body) next.machineId = String(body.machineId || '').trim();
      if ('machineDisplayName' in body) next.machineDisplayName = String(body.machineDisplayName || '').trim().slice(0, 120);
      if ('authMode' in body && ['bearer', 'hmac'].includes(String(body.authMode))) next.authMode = String(body.authMode);
      if ('redactPaths' in body) next.redactPaths = Boolean(body.redactPaths);
      if (body.machineSecret) next.machineSecret = String(body.machineSecret);
      if (body.clearSecret) delete next.machineSecret;

      // Validate the candidate *before* persisting, so a typo cannot leave the
      // machine with a cloud transport that never starts.
      const candidate = resolveCloudConfig({ ...config, cloud: next }, process.env, { dataRoot });
      const candidateCheck = validateCloudConfig(candidate);
      if (!candidateCheck.ok) {
        return errorJson(res, 400, Object.assign(new Error(candidateCheck.problems.join('; ')), { code: 'INPUT_INVALID' }));
      }
      config.cloud = next;
      await saveConfig(rootDir, config);
      const applied = await applyCloudConfig({ quiet: true });
      return json(res, 200, { ok: true, enabled: applied.enabled, machineId: cloudConfig.machineId, url: cloudConfig.url });
    }

    if (req.method === 'POST' && pathname === '/api/cloud/test') {
      const body = await readJson(req);
      const saved = config.cloud || {};
      const candidate = resolveCloudConfig({
        ...config,
        cloud: {
          ...saved,
          enabled: true,
          url: body.url ?? saved.url,
          machineId: body.machineId ?? saved.machineId,
          machineSecret: body.machineSecret || saved.machineSecret
        }
      }, process.env, { dataRoot });
      const candidateCheck = validateCloudConfig(candidate);
      if (!candidateCheck.ok) return json(res, 200, { ok: false, problems: candidateCheck.problems });
      const client = new CloudClient({
        baseUrl: candidate.url,
        machineId: candidate.machineId,
        machineSecret: candidate.machineSecret,
        authMode: candidate.authMode,
        protocolVersion: candidate.protocolVersion,
        timeoutMs: 10000
      });
      try {
        await client.heartbeat(buildMachineHeartbeat({
          machineId: candidate.machineId,
          displayName: candidate.machineDisplayName || null,
          version: build.version,
          status: 'ONLINE',
          protocolVersion: candidate.protocolVersion
        }));
        return json(res, 200, { ok: true, machineId: candidate.machineId, url: candidate.url });
      } catch (error) {
        return json(res, 200, { ok: false, error: { code: error.code || 'INTERNAL_ERROR', message: error.message } });
      }
    }

    // --- web push (§ notifications) ------------------------------------------
    if (req.method === 'GET' && pathname === '/api/push/key') {
      access.require(req);
      // The public half only: the private key never leaves this machine.
      return json(res, 200, { publicKey: push.publicKey, subscriptions: push.list() });
    }

    if (req.method === 'POST' && pathname === '/api/push/subscribe') {
      access.require(req);
      const body = await readJson(req);
      try {
        const saved = await push.subscribe(body.subscription, { name: body.name, deviceId: body.deviceId || null });
        return json(res, 200, { ok: true, subscription: saved });
      } catch (error) {
        return errorJson(res, 400, error);
      }
    }

    if (req.method === 'POST' && pathname === '/api/push/unsubscribe') {
      access.require(req);
      const body = await readJson(req);
      return json(res, 200, { ok: await push.unsubscribe(body.endpoint) });
    }

    // A real notification through the real push service, so "почему не приходит"
    // is answered on the spot instead of at the next finished session.
    if (req.method === 'POST' && pathname === '/api/push/test') {
      access.require(req);
      const result = await push.notify({
        title: 'TaskBridge: проверка',
        body: 'Уведомления работают.',
        taskId: null,
        type: 'TEST',
        at: new Date().toISOString()
      });
      return json(res, 200, result);
    }

    // --- pairing a phone (§ pairing) -----------------------------------------
    // The QR is minted here, on the machine that owns the secret: it carries the
    // public address, this machine's id and a device token signed with the
    // machine secret. The token travels in the URL *fragment*, which a browser
    // never sends to a server — the cloud only ever sees /pair.
    if (req.method === 'POST' && pathname === '/api/cloud/pair') {
      access.require(req);
      // Minting a credential is a local act, like the LAN pairing code.
      if (access.enabled && !access.local(req)) return errorJson(res, 403, Object.assign(new Error('Подключить телефон можно только с самого компьютера.'), { code: 'FORBIDDEN' }));
      if (!cloudConfig.url || !cloudConfig.machineSecret) {
        return errorJson(res, 400, Object.assign(new Error('Сначала настройте облако: адрес и секрет машины.'), { code: 'INPUT_INVALID' }));
      }
      const body = await readJson(req).catch(() => ({}));
      const deviceId = newDeviceId();
      const expiresAt = Date.now() + DEFAULT_DEVICE_TOKEN_TTL_MS;
      const token = issueDeviceToken({ machineId: cloudConfig.machineId, deviceId, secret: cloudConfig.machineSecret });
      const device = await trustedDevices.add({
        deviceId,
        name: body.name,
        machineId: cloudConfig.machineId,
        expiresAt: new Date(expiresAt).toISOString()
      });
      const link = `${cloudConfig.url}/pair#m=${encodeURIComponent(cloudConfig.machineId)}&t=${encodeURIComponent(token)}&r=${encodeURIComponent(cloudConfig.relayUrl || '')}`;
      return json(res, 200, { device, url: link, expiresAt: device.expiresAt, machineId: cloudConfig.machineId });
    }

    if (req.method === 'GET' && pathname === '/api/cloud/devices') {
      access.require(req);
      // Never the tokens themselves: they exist only inside the QR, once.
      return json(res, 200, { devices: trustedDevices.list(), relayUrl: cloudConfig.relayUrl || '', realtime: Boolean(cloudConfig.realtime) });
    }

    {
      const match = pathname.match(/^\/api\/cloud\/devices\/([^/]+)$/);
      if (match && (req.method === 'DELETE' || req.method === 'POST')) {
        access.require(req);
        if (access.enabled && !access.local(req)) return errorJson(res, 403, Object.assign(new Error('Отзывать устройства можно только с компьютера.'), { code: 'FORBIDDEN' }));
        const deviceId = decodeURIComponent(match[1]);
        try {
          // POST revokes (the entry stays visible as revoked), DELETE forgets it.
          if (req.method === 'POST') return json(res, 200, { device: await trustedDevices.revoke(deviceId) });
          await trustedDevices.remove(deviceId);
          return json(res, 200, { ok: true });
        } catch (error) {
          return errorJson(res, error.code === 'NOT_FOUND' ? 404 : 400, error);
        }
      }
    }

    if (req.method === 'GET' && pathname === '/debug/cloud') {
      // Diagnostics only (§88). Never returns the machine secret.
      access.require(req);
      if (!cloudWorker) return json(res, 200, { enabled: false, reason: cloudCheck.ok ? 'Cloud transport is disabled by configuration.' : cloudCheck.problems });
      return json(res, 200, await cloudWorker.status());
    }

    if (req.method === 'GET' && pathname === '/api/metrics') {
      // Local metrics (§89). Prometheus text via ?format=prometheus.
      // delivery — тайминги доставки хода (шаг C-C), независимые от cloud.
      // server — здоровье процесса (фаза 4): uptime, живые SSE-подписчики,
      // глубина цепочек записи событий и счётчик обрывов стрима.
      access.require(req);
      const prometheus = url.searchParams.get('format') === 'prometheus';
      const deliveryText = deliveryMetrics.toPrometheus();
      const serverHealth = () => ({
        uptimeSec: Math.round((Date.now() - Date.parse(deliveryMetrics.snapshot().startedAt)) / 1000),
        sseClients: [...sseClients.values()].reduce((sum, set) => sum + set.size, 0),
        eventChainDepth: manager.eventWrites.size,
        droppedStreams: deliveryMetrics.snapshot().counters.sse_stream_dropped || 0,
        ...clientLinkHealth(),
      });
      if (!cloudWorker) {
        if (prometheus) {
          res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(`# cloud transport disabled\n${deliveryText}`);
        }
        return json(res, 200, { enabled: false, metrics: null, delivery: deliveryMetrics.snapshot(), memory: memoryMetrics.snapshot(), server: serverHealth() });
      }
      if (prometheus) {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(cloudWorker.metrics.toPrometheus() + deliveryText);
      }
      return json(res, 200, { enabled: true, ...cloudWorker.metrics.snapshot(), delivery: deliveryMetrics.snapshot(), memory: memoryMetrics.snapshot(), server: serverHealth() });
    }

    // Приоритетный fast-path (§4.2 плана улучшений): liveness отвечает до
    // access.require и до любых readJson — health не должен ждать за длинными
    // запросами. Очередей в турникете (src/proxy.mjs) нет — проверено; остаточный
    // риск — перегрузка event loop, и её видно по sse_publish_lag_ms.
    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, { status: 'ok' });
    }

    // --- interactive tool approvals (§52–§55) --------------------------------
    // The Pi extension is a local process without a session cookie, so these two
    // endpoints authenticate with the per-task approval token instead. They are
    // handled before the cookie gate for exactly that reason.
    let approvalMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/approval$/);
    if (req.method === 'POST' && approvalMatch) {
      const taskId = approvalMatch[1];
      if (!manager.getTask(taskId)) return errorJson(res, 404, Object.assign(new Error('Session not found'), { code: 'NOT_FOUND' }));
      if (!manager.checkApprovalToken(taskId, req.headers['x-taskbridge-approval'])) {
        return errorJson(res, 403, Object.assign(new Error('Invalid approval token'), { code: 'FORBIDDEN' }));
      }
      const body = await readJson(req);
      return json(res, 200, manager.beginApproval(taskId, body));
    }
    approvalMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/approval\/([^/]+)$/);
    if (req.method === 'GET' && approvalMatch) {
      const taskId = approvalMatch[1];
      if (!manager.checkApprovalToken(taskId, req.headers['x-taskbridge-approval'])) {
        return errorJson(res, 403, Object.assign(new Error('Invalid approval token'), { code: 'FORBIDDEN' }));
      }
      const state = manager.approvalStatus(taskId, approvalMatch[2]);
      return state
        ? json(res, 200, state)
        : errorJson(res, 404, Object.assign(new Error('Approval not found'), { code: 'NOT_FOUND' }));
    }

    if (pathname.startsWith('/api/')) access.require(req);

    // Local setup for TaskBridge-owned OpenAI-compatible providers. Not available
    // over LAN: API keys remain in the Windows process environment, and no
    // untrusted client may reconfigure what endpoint Pi talks to.
    if (pathname === '/api/provider-profiles' || pathname.startsWith('/api/provider-profiles/')) {
      if (!access.local(req)) {
        return errorJson(res, 403, Object.assign(new Error('Настраивать провайдеры можно только на компьютере через localhost.'), { code: 'ORIGIN_FORBIDDEN' }));
      }
      if (req.method === 'GET' && pathname === '/api/provider-profiles') {
        return json(res, 200, await providerProfiles.list());
      }
      if (req.method === 'PUT' && pathname === '/api/provider-profiles') {
        const body = await readJson(req);
        const result = await providerProfiles.upsert(body);
        // Модели записи изменились прямо сейчас: закэшированный каталог Pi
        // описывает прежний models.json (STAB-00, обновление каталога после правки).
        manager.modelCatalog?.invalidate?.();
        return json(res, 200, result);
      }
      // Мастер подключения, шаги 3–4 (пункт 2.3 плана): проверка ещё не сохранённого
      // подключения и каталог его моделей. Разрешение адреса и запрет redirect — там же.
      // Убрать модели из записи провайдера (запрос оператора 2026-10-22): правится
      // ТОЛЬКО список моделей, с ревизией файла и резервной копией.
      const modelRemoval = pathname.match(/^\/api\/provider-profiles\/([^/]+)\/models\/remove$/);
      if (req.method === 'POST' && modelRemoval) {
        const body = await readJson(req);
        const result = await providerProfiles.removeModels(decodeURIComponent(modelRemoval[1]), {
          models: body?.models ?? [],
          revision: body?.revision ?? null,
        });
        // Убранная модель не должна оставаться в выборе модели ещё TTL каталога.
        manager.modelCatalog?.invalidate?.();
        return json(res, 200, result);
      }
      if (req.method === 'POST' && pathname === '/api/provider-profiles/draft-check') {
        const body = await readJson(req);
        return json(res, 200, await providerProfiles.draftCheck({
          baseUrl: body?.baseUrl,
          keyEnv: body?.keyEnv ?? '',
          kind: body?.kind ?? 'remote',
          limit: body?.limit,
        }));
      }
      const providerRoute = pathname.match(/^\/api\/provider-profiles\/([^/]+)(?:\/(check))?$/);
      if (providerRoute) {
        const id = providerRoute[1];
        if (req.method === 'POST' && providerRoute[2] === 'check') {
          return json(res, 200, await providerProfiles.check(id));
        }
        if (req.method === 'DELETE' && !providerRoute[2]) {
          const body = await readJson(req);
          const result = await providerProfiles.remove(id, body.revision);
          manager.modelCatalog?.invalidate?.();
          return json(res, 200, result);
        }
      }
    }

    if (req.method === 'GET' && pathname === '/api/runtime') return json(res, 200, await runtimeControl.status());
    if (req.method === 'POST' && pathname === '/api/runtime/start') {
      if (manager.localModels.enabled) return errorJson(res, 409, Object.assign(new Error('Активен router-режим (localRuntime.router): управление локальными моделями — через /api/local/*.'), { code: 'NOT_CONFIGURED' }));
      const { profileId } = await readJson(req);
      if (manager.activeTaskId || manager.admitting || manager.runtimeChanging) throw Object.assign(new Error('Дождитесь завершения текущей операции.'), { code: 'MODEL_BUSY' });
      manager.runtimeChanging = true;
      try { await manager.runtimeManager.ensureRunning(() => {}, profileId); }
      finally { manager.runtimeChanging = false; }
      return json(res, 200, await runtimeControl.status());
    }
    if (req.method === 'POST' && pathname === '/api/runtime/restart') {
      if (manager.localModels.enabled) return errorJson(res, 409, Object.assign(new Error('Активен router-режим (localRuntime.router): управление локальными моделями — через /api/local/*.'), { code: 'NOT_CONFIGURED' }));
      const { profileId } = await readJson(req);
      await runtimeControl.restart(profileId);
      return json(res, 200, await runtimeControl.status());
    }

    // Restart the whole TaskBridge process (not a model profile). The HTTP
    // response must reach the client before the server dies, so the real work
    // runs in a detached helper with a short delay. Confirmation is a body flag,
    // not just a button: without it the probe in tests/api-contract.test.mjs
    // would restart the server it is checking.
    if (req.method === 'POST' && pathname === '/api/server/restart') {
      const body = await readJson(req).catch(() => ({}));
      if (body?.confirm !== true) {
        return errorJson(res, 400, Object.assign(new Error('Перезапуск сервера требует подтверждения (confirm: true).'), { code: 'INPUT_INVALID' }));
      }
      // No busy gate here, deliberately: a restart relaunches the whole tree
      // (taskkill /T in the helper script), so it cannot rely on anything inside
      // the dying process — including the very flags that say "busy". Those
      // flags are exactly what a stuck state leaves behind, and the restart is
      // the only escape hatch that resets them. The UI confirm dialog already
      // warns that active sessions will be interrupted; confirm:true is that
      // warning for API callers.
      const triggered = await triggerRestart({ reason: 'api' });
      return json(res, 202, { restarting: true, mode: triggered.mode, pid: triggered.pid });
    }

    // Power off the machine the server runs on. The same confirm-gate as
    // /api/server/restart: the contract probe in tests/api-contract.test.mjs
    // POSTs {} to every route and must never power anything down. The
    // 10-second cancel countdown lives in the client; the server only runs
    // the final command, so a dead app cannot leave a scheduled shutdown behind.
    if (req.method === 'POST' && pathname === '/api/system/shutdown') {
      const body = await readJson(req).catch(() => ({}));
      if (body?.confirm !== true) {
        return errorJson(res, 400, Object.assign(new Error('Выключение компьютера требует подтверждения (confirm: true).'), { code: 'INPUT_INVALID' }));
      }
      const command = process.platform === 'win32'
        ? { file: 'shutdown', args: ['/s', '/t', '0'] }
        : process.platform === 'darwin'
          ? { file: 'osascript', args: ['-e', 'tell application "System Events" to shut down'] }
          : { file: 'shutdown', args: ['-h', 'now'] };
      try {
        const child = spawn(command.file, command.args, { windowsHide: true, stdio: 'ignore' });
        // A missing shutdown binary reports asynchronously: swallow it instead
        // of crashing the whole server over one failed power-off.
        child.on('error', () => {});
        return json(res, 200, { shuttingDown: true, command: command.file });
      } catch (error) {
        return errorJson(res, 500, Object.assign(new Error(`Выключить компьютер не удалось: ${error.message}`), { code: 'SHUTDOWN_FAILED' }));
      }
    }
    if (req.method === 'POST' && pathname === '/api/system/reboot') {
      const body = await readJson(req).catch(() => ({}));
      if (body?.confirm !== true) {
        return errorJson(res, 400, Object.assign(new Error('Перезагрузка компьютера требует подтверждения (confirm: true).'), { code: 'INPUT_INVALID' }));
      }
      const command = process.platform === 'win32'
        ? { file: 'shutdown', args: ['/r', '/t', '0'] }
        : process.platform === 'darwin'
          ? { file: 'osascript', args: ['-e', 'tell application "System Events" to restart'] }
          : { file: 'shutdown', args: ['-r', 'now'] };
      try {
        const child = spawn(command.file, command.args, { windowsHide: true, stdio: 'ignore' });
        child.on('error', () => {});
        return json(res, 200, { rebooting: true, command: command.file });
      } catch (error) {
        return errorJson(res, 500, Object.assign(new Error(`Перезагрузить компьютер не удалось: ${error.message}`), { code: 'REBOOT_FAILED' }));
      }
    }

    // Refresh only the selected account; repeated clicks share a request and
    // never generate more than one provider read per 20 seconds.
    if (req.method === 'POST' && pathname === '/api/providers/refresh') {
      const { provider } = await readJson(req);
      if (!['wormsoft', 'routerai', 'deepseek', 'openai-codex'].includes(provider)) {
        throw Object.assign(new Error('Неизвестный провайдер.'), { code: 'INPUT_INVALID' });
      }
      const last = providerRefreshes.get(provider);
      if (last && Date.now() - last.at < 20_000) return json(res, 200, { [provider]: await last.promise });
      const options = { env: process.env, noCache: true, minRefreshMs: 20_000,
        storagePath: path.join(dataRoot, 'wormsoft-usage.json') };
      const promise = (async () => {
        if (provider === 'wormsoft') return readWormsoftStatus(config.providerStatus?.wormsoft, options);
        if (provider === 'routerai') return readRouterAiStatus(config.providerStatus?.routerai, options);
        if (provider === 'openai-codex') return readOpenAiCodexStatus(config.providerStatus?.openaiCodex, options);
        const status = await readDeepseekCost(config.deepseek, options);
        return { ...status, provider: 'deepseek', label: 'DeepSeek', kind: 'balance' };
      })();
      providerRefreshes.set(provider, { at: Date.now(), promise });
      return json(res, 200, { [provider]: await promise });
    }

    // Свой push в локальной сети (4.3): устройство регистрирует свой приёмник.
    // Адрес берём из соединения, порт — из тела; публичный адрес отклоняется.
    if (req.method === 'POST' && pathname === '/api/clients/wake') {
      const body = await readJson(req);
      const result = manager.wakeChannel.register({
        address: WakeChannel.normalize(req.socket?.remoteAddress),
        port: body?.port,
      });
      if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code });
      return json(res, 200, result);
    }

    // Фаза 4: клиент сообщает переход связи (live / degraded / reconnecting).
    // Только счётчики и причины — ни содержимого промптов, ни истории; сервер
    // показывает эпизоды в /api/metrics, чтобы «часто отваливается» стало
    // числом, а не воспоминанием.
    if (req.method === 'POST' && pathname === '/api/clients/link') {
      const body = await readJson(req).catch(() => ({}));
      return json(res, 200, noteClientLink(req, body));
    }

    // Проверка соединения с провайдером (TB-PROV-01B). Read-only: один `GET /models`
    // по адресу из каталога Pi или из локальных серверов. Адрес из тела запроса не
    // принимается — иначе проверка стала бы SSRF-ручкой.
    if (req.method === 'POST' && pathname === '/api/providers/check') {
      const body = await readJson(req);
      return json(res, 200, await manager.checkProvider({
        provider: body?.provider ?? null,
        id: body?.id ?? null,
        requestId: req.headers['x-taskbridge-request-id'] || null,
      }));
    }

    // Короткая проверка модели по кнопке (пункт §3.3 плана): доступность без токенов
    // и задержка (один токен) по явному нажатию.
    if (req.method === 'POST' && pathname === '/api/models/probe') {
      const body = await readJson(req);
      return json(res, 200, await manager.probeModel({
        provider: body?.provider ?? null,
        id: body?.id ?? null,
        mode: body?.mode ?? 'availability',
      }));
    }

    if (req.method === 'GET' && pathname === '/api/models') {
      const refresh = url.searchParams.get('refresh') === '1';
      return json(res, 200, await manager.listModels({ refresh }));
    }

    if (req.method === 'GET' && pathname === '/api/local') {
      // Deliberate user action: it may probe Pi once so the advertised provider
      // id is one Pi actually serves, and `?fresh=1` (кнопка «Обновить») отвечает
      // без 5-секундного кэша — по нему видно удалённые с диска веса.
      const fresh = url.searchParams.get('fresh') === '1';
      return json(res, 200, await manager.localStatus({ probeCatalog: true, fresh }));
    }
    if (req.method === 'POST' && pathname === '/api/local/start') {
      return json(res, 200, await manager.startLocal());
    }
    if (req.method === 'POST' && pathname === '/api/local/load') {
      const { model } = await readJson(req);
      return json(res, 200, await manager.loadLocalModel(model));
    }
    if (req.method === 'POST' && pathname === '/api/local/unload') {
      const { model } = await readJson(req);
      return json(res, 200, await manager.unloadLocalModel(model));
    }
    if (req.method === 'POST' && pathname === '/api/local/context') {
      // Размер контекста — параметр ЗАГРУЗКИ: меняется не сессия, а конфиг,
      // из которого внешний сервер стартует движок. Поэтому ответ описывает
      // саму запись (файл, было/стало, нужна ли перезагрузка), а не статус.
      const { model, context } = await readJson(req);
      return json(res, 200, await manager.setLocalContext(model, context));
    }
    if (req.method === 'POST' && pathname === '/api/local/vision') {
      // Vision пресета роутера — ключи mmproj/no-mmproj его секции в models.ini,
      // то есть та же правка конфига, что и контекст: ответ описывает запись, а
      // не статус (запускать/перезапускать роутер решает пользователь).
      const { model, vision } = await readJson(req);
      return json(res, 200, await manager.setLocalVision(model, vision));
    }
    if (req.method === 'POST' && pathname === '/api/local/forget') {
      // «Убрать из списка»: удаляем запись из конфига, а не модель. У строки
      // внешнего сервера это config.json (localRuntime.externalServers), у
      // пресета роутера — секция в models.ini, у найденной автоматически строки
      // (провайдер Pi + каталог установки) удалять нечего — она скрывается
      // (localRuntime.externalHidden). Запись обязательно сохраняется — иначе
      // строка вернётся после перезапуска, и список перестанет быть правдой.
      const { model } = await readJson(req);
      const removed = manager.forgetLocalServer(model);
      if (removed) {
        await saveConfig(rootDir, config);
        return json(res, 200, { removed: { provider: removed.provider ?? null, model: removed.model ?? null }, ...await manager.localStatus({}) });
      }
      const preset = await manager.forgetLocalPreset(model);
      if (preset) {
        return json(res, 200, { removed: { provider: null, model, preset: preset.preset }, ...await manager.localStatus({}) });
      }
      const hidden = manager.hideLocalServer(model);
      if (hidden) {
        await saveConfig(rootDir, config);
        return json(res, 200, { removed: { provider: hidden.provider, model: hidden.model, hidden: true }, ...await manager.localStatus({}) });
      }
      throw Object.assign(new Error(
        'Этой модели нет ни в конфиге TaskBridge, ни в models.ini, ни среди найденных по Pi — убирать нечего.'),
      { code: 'INPUT_INVALID' });
    }
    if (req.method === 'POST' && pathname === '/api/local/unhide') {
      // Вернуть скрытую строку: она снова появится в списке (её источник — Pi и
      // каталог установки, туда мы не пишем).
      const { model } = await readJson(req);
      const restored = manager.unhideLocalServer(model);
      if (!restored) {
        throw Object.assign(new Error(`${model} нет среди скрытых.`), { code: 'INPUT_INVALID' });
      }
      await saveConfig(rootDir, config);
      return json(res, 200, await manager.localStatus({}));
    }
    if (req.method === 'POST' && pathname === '/api/local/stop') {
      return json(res, 200, await manager.stopLocal());
    }

    // --- процессы машины: список для панели «Процессы» и точечный kill ---
    if (req.method === 'GET' && pathname === '/api/processes') {
      // Без ?fresh=1 — кэш 5 с из process-info (WMI-опрос стоит ~1 с).
      const fresh = url.searchParams.get('fresh') === '1';
      const processes = await listProcesses({ fresh });
      return json(res, 200, { processes });
    }
    if (req.method === 'GET' && pathname === '/api/processes/gpu') {
      return json(res, 200, { processes: await listGpuProcesses() });
    }
    if (req.method === 'GET' && pathname === '/api/system/resources') {
      // PROC-01: aggregated resource snapshot. gpus is null when nvidia-smi is
      // unavailable; null VRAM fields mean "unknown", never zero.
      return json(res, 200, { ram: systemRam(), gpu: await gpuSummary() });
    }
    if (req.method === 'GET' && /^\/api\/system\/cleanup\/history$/.test(pathname)) {
      return json(res, 200, { history: cleanupHistory() });
    }
    if (req.method === 'GET' && /^\/api\/system\/cleanup\/[^/]+$/.test(pathname)) {
      const id = pathname.split('/').pop();
      const result = getCleanupResultByCommand(id);
      if (!result) return errorJson(res, 404, Object.assign(new Error('Результат с таким commandId не найден.'), { code: 'NOT_FOUND' }));
      return json(res, 200, result);
    }
    if (req.method === 'POST' && pathname === '/api/system/cleanup/preview') {
      const body = await readJson(req).catch(() => ({}));
      return json(res, 200, await createCleanupPreview({
        objective: body.objective === 'gpu' ? 'gpu' : 'ram',
        pids: Array.isArray(body.pids) ? body.pids : null,
        limit: Number.isInteger(body.limit) ? body.limit : 30,
        targetFreeRamBytes: Number.isFinite(body.targetFreeRamBytes) ? body.targetFreeRamBytes : null,
      }));
    }
    if (req.method === 'POST' && pathname === '/api/system/cleanup/execute') {
      // PROC-07: batch killing is forbidden via a public relay by default —
      // only a device on the server machine itself may execute a plan.
      if (access.enabled && !access.local(req)) {
        return errorJson(res, 403, Object.assign(new Error('Массовая остановка процессов доступна только на компьютере сервера.'), { code: 'FORBIDDEN' }));
      }
      const body = await readJson(req);
      return json(res, 200, await executeCleanup(body));
    }
    if (req.method === 'POST' && pathname === '/api/processes/kill') {
      const body = await readJson(req).catch(() => ({}));
      // Пустое тело от contract-пробы обязано уйти в ошибку ввода, а не в kill:
      // без pid/name здесь не стреляем (см. защиту в process-kill.mjs).
      return json(res, 200, await killProcess(body));
    }
    if (req.method === 'POST' && pathname === '/api/processes/kill-group') {
      const body = await readJson(req).catch(() => ({}));
      return json(res, 200, await killProcessesByRuntime(body.runtime));
    }

    // --- локальная библиотека моделей + Hugging Face ---
    if (req.method === 'GET' && pathname === '/api/hf/search') {
      const query = url.searchParams.get('q') || '';
      return json(res, 200, await manager.hfSearch(query));
    }
    if (req.method === 'GET' && pathname === '/api/hf/repo') {
      const repo = url.searchParams.get('repo');
      if (!repo) throw Object.assign(new Error('Нужен параметр repo.'), { code: 'INPUT_INVALID' });
      const revision = url.searchParams.get('revision') || 'main';
      return json(res, 200, await manager.hfRepo(repo, revision));
    }
    if (req.method === 'POST' && pathname === '/api/hf/download') {
      const body = await readJson(req);
      return json(res, 202, await manager.hfDownload(body));
    }
    if (req.method === 'GET' && pathname === '/api/hf/downloads') {
      return json(res, 200, manager.hfDownloads());
    }
    if (req.method === 'POST' && pathname === '/api/hf/downloads/clear') {
      // Убрать завершённые задания из списка: файлы установленных моделей
      // не трогаются — они живут в библиотеке.
      return json(res, 200, manager.hfDownloadsClear());
    }
    if (req.method === 'POST' && pathname === '/api/hf/downloads/cancel') {
      const { id } = await readJson(req);
      return json(res, 200, manager.hfCancelDownload(id));
    }
    if (req.method === 'POST' && pathname === '/api/hf/downloads/retry') {
      const { id } = await readJson(req);
      return json(res, 200, await manager.hfRetryDownload(id));
    }
    if (req.method === 'GET' && pathname === '/api/library') {
      const fresh = url.searchParams.get('fresh') === '1';
      return json(res, 200, await manager.libraryStatus({ fresh }));
    }
    if (req.method === 'POST' && pathname === '/api/library/scan') {
      return json(res, 200, await manager.libraryScan());
    }
    if (req.method === 'POST' && pathname === '/api/library/forget') {
      const { id } = await readJson(req);
      return json(res, 200, await manager.libraryForget(id));
    }
    if (req.method === 'POST' && pathname === '/api/library/register') {
      // «Прописать в Pi»: пресет в models.ini роутера. Pi перечисляет модели
      // роутера через своего провайдера; в его models.json TaskBridge не пишет.
      const { id, ctxSize } = await readJson(req);
      return json(res, 200, await manager.libraryRegister(id, { ctxSize }));
    }
    if (req.method === 'POST' && pathname === '/api/library/run') {
      // «Запустить» модель из библиотеки: при необходимости перезапускает
      // управляемый роутер (перечитать models.ini) и грузит пресет.
      const { id } = await readJson(req);
      return json(res, 200, await manager.libraryRun(id));
    }
    if (req.method === 'POST' && pathname === '/api/library/delete') {
      // Удаление скачанной модели: пресет из models.ini, файлы записи (кроме
      // общих с другими записями, например vision-проектора), пустой каталог.
      const { id } = await readJson(req);
      return json(res, 200, await manager.libraryDelete(id));
    }
    if (req.method === 'GET' && pathname === '/api/local/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write('retry: 2000\n\n');
      const send = (type, data) => { try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {} };
      const onStatus = data => send('status', data);
      const onProgress = data => send('progress', data);
      const onEvent = data => send('event', data);
      manager.localModels.on('status', onStatus);
      manager.localModels.on('progress', onProgress);
      manager.localModels.on('event', onEvent);
      manager.localStatus().then(status => send('snapshot', status)).catch(() => {});
      const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      res.on('close', () => {
        clearInterval(heartbeat);
        manager.localModels.off('status', onStatus);
        manager.localModels.off('progress', onProgress);
        manager.localModels.off('event', onEvent);
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/mcp') {
      return json(res, 200, await manager.mcpStatus());
    }
    if (req.method === 'POST' && pathname === '/api/mcp/mode') {
      const body = await readJson(req);
      const mode = String(body.mode || '');
      if (!['inherit', 'managed', 'off'].includes(mode)) throw Object.assign(new Error('Неизвестный режим MCP.'), { code: 'INPUT_INVALID' });
      config.pi = config.pi || {};
      config.pi.mcp = { ...(config.pi.mcp || {}), mode };
      await saveConfig(rootDir, config);
      await manager.mcp.ensureReady().catch(() => {});
      return json(res, 200, await manager.mcpStatus());
    }
    if (req.method === 'POST' && pathname === '/api/mcp/import') {
      return json(res, 200, await manager.importMcp());
    }
    if (req.method === 'POST' && pathname === '/api/mcp/servers') {
      const body = await readJson(req);
      if (typeof body.name !== 'string' || !body.name.trim()) throw Object.assign(new Error('Не указан MCP-сервер.'), { code: 'INPUT_INVALID' });
      return json(res, 200, await manager.setMcpServer(body.name.trim(), body.enabled !== false));
    }
    if (req.method === 'POST' && pathname === '/api/mcp/tools') {
      const body = await readJson(req);
      if (typeof body.server !== 'string' || !body.server.trim()) throw Object.assign(new Error('Не указан MCP-сервер.'), { code: 'INPUT_INVALID' });
      return json(res, 200, await manager.setMcpTool(body.server.trim(), body.tool, body.enabled !== false));
    }
    if (req.method === 'POST' && pathname === '/api/mcp/health') {
      const body = await readJson(req);
      return json(res, 200, await manager.probeMcp(typeof body.server === 'string' && body.server.trim() ? body.server.trim() : null));
    }
    if (req.method === 'POST' && pathname === '/api/mcp/definitions') {
      const body = await readJson(req);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) throw Object.assign(new Error('Не указан MCP-сервер.'), { code: 'INPUT_INVALID' });
      if (body.remove === true) return json(res, 200, await manager.removeMcpServer(name));
      return json(res, 200, await manager.upsertMcpServer(name, { url: body.url, command: body.command, args: body.args }));
    }

    if (req.method === 'GET' && pathname === '/api/info') {
      const [busy, modelReady, engine, local, system, providerStatuses] = await Promise.all([
        manager.local.getBusyStatus(), manager.local.isReady(), manager.local.getEngineInfo(), manager.localStatus(), readSystemMetrics(),
        readProviderStatuses(config, {
          env: process.env,
          // Usage samples must survive restarts; isolated instances keep their own file.
          storagePath: path.join(dataRoot, 'wormsoft-usage.json'),
          // The poll serves the last known state without touching providers: an
          // always-on status endpoint must not get the account blocked. The
          // operator refreshes explicitly (POST /api/providers/refresh), and
          // each real model run samples the remainder by itself.
          cacheOnly: true,
        }).catch(() => ({}))
      ]);
      // Keep the original field for clients written before providerStatuses.
      const deepseek = providerStatuses.deepseek || { available: false, reason: 'error' };
      const settings = await readPiSettings().catch(() => null);
      const warnings = [];
      if (imagesBlocked(settings)) {
        warnings.push({
          code: 'PI_IMAGES_BLOCKED',
          message: 'В настройках Pi включён images.blockImages — Pi заменяет любые картинки на текст «Image reading is disabled.» до отправки модели. Выключите его командой /images или в /settings, иначе никакая vision-модель не увидит вложения.'
        });
      }
      const pi = piVersion.current();
      if (pi?.version && !pi.supported) {
        warnings.push({
          code: 'PI_VERSION_UNSUPPORTED',
          message: `Pi ${pi.version} не проверялся с этой версией TaskBridge (поддерживается ${pi.supportedRange}). Сессии могут вести себя неожиданно.`
        });
      }
      return json(res, 200, {
        name: 'TaskBridge MVP',
        build,
        bootId,
        // План автоматического перезапуска виден оператору: когда следующий и почему
        // прошлый тик ничего не сделал (deferred = ждём, пока освободятся сессии).
        autoRestart: {
          enabled: autoRestartConfig.enabled,
          everyHours: autoRestartConfig.everyHours || null,
          at: autoRestartConfig.at,
          onlyWhenIdle: autoRestartConfig.onlyWhenIdle,
          lastRestartAt: lastAutoRestartAt ? new Date(lastAutoRestartAt).toISOString() : null,
          nextAt: nextRestartAt(autoRestartConfig, { startedAt: serverStartedAt })?.toISOString() ?? null,
          state: autoRestartState,
        },
        apiVersion: API_VERSION,
        storeId: store.storeId,
        // Which parts of the plan API this build actually serves. A client that
        // knows its own list can say «сервер старше приложения», instead of
        // showing a bare 404 from a route this server does not have (FP-UX-02G).
        followPlan: {
          enabled: followPlan.enabled,
          capabilities: followPlan.enabled
            ? ['status', 'attach', 'detach', 'browse', 'scan', 'inspect', 'import', 'read-file', 'save-file', 'ai-draft', 'content', 'start', 'pause', 'resume', 'stop', 'reconcile', 'ai-review']
            : []
        },
        // «Pi отсутствует» и «Pi несовместим» — разные состояния: по одному
        // version нельзя понять, чего именно не хватает.
        pi: { ...pi, source: piCommand.source, state: piRuntimeState(pi) },
        addresses: !lanOpen ? [] : [
          ...lanAddresses(publicPort),
          ...(httpsConfig.enabled && !tlsDisabled ? lanAddresses(Number(httpsConfig.port || 8443), 'https') : [])
        ],
        modelBusy: busy.unknown ? null : busy.busy,
        modelReady,
        engine,
        system,
        local,
        scheduler: manager.schedulerInfo(),
        providerStatuses,
        deepseek,
        warnings,
        fileLimits: FILE_LIMITS
      });
    }

    if (req.method === 'GET' && pathname === '/api/projects') {
      return json(res, 200, manager.listProjects());
    }

    // Project dashboard (MR-01): the overview is computed from the registry and
    // the sessions, only pinned/archived are stored (SQLite, survives a restart).
    // Declared before `/api/projects/:id` so "overview" is never read as an id.
    if (req.method === 'GET' && pathname === '/api/projects/overview') {
      return json(res, 200, manager.projectOverview());
    }

    // Консолидация памяти (этап M3): кандидаты на слияние (только чтение) и
    // оформление пары предложением — тем же гейтом, что и остальная память.
    const consolidationRoute = pathname.match(/^\/api\/projects\/([^/]+)\/memory\/consolidation$/);
    if (consolidationRoute) {
      const projectId = decodeURIComponent(consolidationRoute[1]);
      if (req.method === 'GET') {
        return json(res, 200, await manager.memoryConsolidation(projectId, {
          threshold: url.searchParams.get('threshold'),
          limit: Number(url.searchParams.get('limit')) || 10,
        }));
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        return json(res, 201, await manager.proposeMerge(projectId, {
          first: body.first, second: body.second, reason: body.reason ?? null,
        }));
      }
    }

    // Очередь предложений памяти по всем проектам (этап M2): ?projectId= сужает.
    if (req.method === 'GET' && pathname === '/api/memory/proposals') {
      return json(res, 200, await manager.listAllMemoryProposals({
        projectId: url.searchParams.get('projectId'),
      }));
    }

    // Поиск по индексу памяти (этап M2): ?q обязателен, ?scope=project|global|all,
    // ?projectId= — какой проект считать «своим» для режима all.
    if (req.method === 'GET' && pathname === '/api/memory/search') {
      return json(res, 200, await manager.searchMemory({
        query: url.searchParams.get('q'),
        scope: url.searchParams.get('scope') || 'project',
        projectId: url.searchParams.get('projectId'),
        limit: Number(url.searchParams.get('limit')) || 20,
      }));
    }

    const projectMemoryRoute = pathname.match(/^\/api\/projects\/([^/]+)\/memory$/);
    if (req.method === 'GET' && projectMemoryRoute) {
      return json(res, 200, await manager.projectMemory(decodeURIComponent(projectMemoryRoute[1]), {
        query: url.searchParams.get('q'),
      }));
    }

    // Memory Suggestions (MEM-08): предложение живёт в изолированном буфере и
    // становится знанием только после явного принятия — методом POST, а не
    // побочным эффектом чтения.
    const memoryProposalsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/memory\/proposals(?:\/([^/]+)\/(accept|reject))?$/);
    if (memoryProposalsRoute) {
      const projectId = decodeURIComponent(memoryProposalsRoute[1]);
      const proposalId = memoryProposalsRoute[2] ? decodeURIComponent(memoryProposalsRoute[2]) : null;
      const action = memoryProposalsRoute[3] ?? null;
      if (req.method === 'GET' && !proposalId) {
        return json(res, 200, await manager.listMemoryProposals(projectId));
      }
      if (req.method === 'POST' && !proposalId) {
        return json(res, 201, await manager.createMemoryProposal(projectId, await readJson(req)));
      }
      if (req.method === 'POST' && action === 'accept') {
        return json(res, 200, await manager.acceptMemoryProposal(projectId, proposalId));
      }
      if (req.method === 'POST' && action === 'reject') {
        const body = await readJson(req).catch(() => ({}));
        return json(res, 200, await manager.rejectMemoryProposal(projectId, proposalId, { reason: body?.reason ?? null }));
      }
    }

    // Work Items (MR-02): the semantic state of the work — what we are trying to
    // do, the criteria of done and where it stands. Nothing else lives here.
    if (req.method === 'GET' && pathname === '/api/work-items') {
      return json(res, 200, {
        items: manager.listWorkItems({
          projectId: url.searchParams.get('projectId'),
          status: url.searchParams.get('status'),
          includeClosed: url.searchParams.get('includeClosed') !== '0'
        })
      });
    }
    if (req.method === 'POST' && pathname === '/api/work-items') {
      return json(res, 201, manager.createWorkItem(await readJson(req)));
    }

    // A work item with the sessions that did the work (MR-03). Declared before the
    // plain /:id route so «sessions» is never read as part of an id.
    const workItemSessionsRoute = pathname.match(/^\/api\/work-items\/([^/]+)\/sessions(?:\/([^/]+))?$/);
    if (workItemSessionsRoute) {
      const workItemId = decodeURIComponent(workItemSessionsRoute[1]);
      const sessionId = workItemSessionsRoute[2] ? decodeURIComponent(workItemSessionsRoute[2]) : null;
      if (req.method === 'GET' && !sessionId) {
        return json(res, 200, { items: manager.workItemDetail(workItemId).sessions });
      }
      if (req.method === 'POST' && !sessionId) {
        const body = await readJson(req);
        return json(res, 201, manager.linkWorkItemSession(workItemId, body.sessionId, body.relation ?? null));
      }
      if (req.method === 'DELETE' && sessionId) {
        return json(res, 200, manager.unlinkWorkItemSession(workItemId, sessionId));
      }
    }

    // MR-04: the resume engine. GET is the preview (what the operator confirms),
    // POST starts a NEW short session from the rendered brief. The launch re-reads
    // the facts and refuses with the list of changes when the preview no longer
    // matches — «preview ≠ launch».
    const resumeRoute = pathname.match(/^\/api\/work-items\/([^/]+)\/resume$/);
    if (resumeRoute) {
      const workItemId = decodeURIComponent(resumeRoute[1]);
      if (req.method === 'GET') {
        return json(res, 200, await manager.resumePreview(workItemId, {
          strategy: url.searchParams.get('strategy'),
          memoryMode: url.searchParams.get('memory'),
        }));
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        const started = await manager.startResume(workItemId, {
          strategy: body.strategy ?? null,
          memoryMode: body.memory ?? null,
          preview: body.preview ?? null,
          sessionIds: Array.isArray(body.sessionIds) ? body.sessionIds : null,
          clientId: body.clientId ?? null,
          deviceId: access.device(req)?.deviceId,
        });
        return json(res, 201, started);
      }
    }

    // Run recipes (MR-05): HOW the work is done, reusable by hand, by the
    // scheduler (MR-06), from the phone or by an event. The run itself is a
    // session — there is no second table about the same fact.
    if (req.method === 'GET' && pathname === '/api/recipes') {
      return json(res, 200, { items: manager.listRecipes({ projectId: url.searchParams.get('projectId') }) });
    }
    if (req.method === 'POST' && pathname === '/api/recipes') {
      return json(res, 201, manager.createRecipe(await readJson(req)));
    }
    const recipeRunRoute = pathname.match(/^\/api\/recipes\/([^/]+)\/run$/);
    if (req.method === 'POST' && recipeRunRoute) {
      const body = await readJson(req).catch(() => ({}));
      const started = await manager.runRecipe(decodeURIComponent(recipeRunRoute[1]), {
        parameters: body.parameters ?? {},
        trigger: body.trigger === 'schedule' ? 'schedule' : 'manual',
        clientId: body.clientId ?? null,
        deviceId: access.device(req)?.deviceId,
      });
      return json(res, 201, started);
    }
    const recipeRoute = pathname.match(/^\/api\/recipes\/([^/]+)$/);
    if (recipeRoute) {
      const id = decodeURIComponent(recipeRoute[1]);
      if (req.method === 'GET') return json(res, 200, manager.getRecipe(id));
      if (req.method === 'PATCH') return json(res, 200, manager.updateRecipe(id, await readJson(req).catch(() => ({}))));
      if (req.method === 'DELETE') return json(res, 200, { ok: true, removed: manager.deleteRecipe(id) });
    }

    // Schedules and their invocations (MR-06): the scheduler runs HERE, on the
    // machine, so a phone that is off changes nothing about whether 09:00 happens.
    if (req.method === 'GET' && pathname === '/api/schedules') {
      return json(res, 200, { items: manager.listSchedules({ recipeId: url.searchParams.get('recipeId') }) });
    }
    if (req.method === 'POST' && pathname === '/api/schedules') {
      return json(res, 201, manager.createSchedule(await readJson(req)));
    }
    const scheduleRunRoute = pathname.match(/^\/api\/schedules\/([^/]+)\/run$/);
    if (req.method === 'POST' && scheduleRunRoute) {
      const body = await readJson(req).catch(() => ({}));
      const invocation = await manager.runScheduleNow(decodeURIComponent(scheduleRunRoute[1]), {
        clientId: body.clientId ?? null,
        deviceId: access.device(req)?.deviceId,
      });
      return json(res, 201, invocation);
    }
    const scheduleRoute = pathname.match(/^\/api\/schedules\/([^/]+)$/);
    if (scheduleRoute) {
      const id = decodeURIComponent(scheduleRoute[1]);
      if (req.method === 'GET') return json(res, 200, manager.getSchedule(id));
      if (req.method === 'PATCH') return json(res, 200, manager.updateSchedule(id, await readJson(req).catch(() => ({}))));
      if (req.method === 'DELETE') return json(res, 200, { ok: true, removed: manager.deleteSchedule(id) });
    }

    // «Выполнить тик сейчас»: диагностика расписаний, не дожидаясь 09:00, и то, чем
    // проверяются политики пропусков. Только на самой машине: это операция над
    // всеми расписаниями сразу, а не над одним из них (для одного есть
    // POST /api/schedules/:id/run).
    if (req.method === 'POST' && pathname === '/api/scheduler/tick') {
      if (!access.local(req)) return errorJson(res, 403, Object.assign(new Error('Тик планировщика можно запустить только на компьютере сервера.'), { code: 'FORBIDDEN' }));
      const body = await readJson(req).catch(() => ({}));
      const nowIso = typeof body.now === 'string' && !Number.isNaN(Date.parse(body.now)) ? new Date(body.now).toISOString() : undefined;
      const result = await manager.schedulerTick(nowIso ? { nowIso } : {});
      await notifyFinishedInvocations(result?.reconciled ?? []);
      return json(res, 200, result);
    }

    if (req.method === 'GET' && pathname === '/api/invocations') {
      return json(res, 200, {
        items: manager.listInvocations({
          recipeId: url.searchParams.get('recipeId'),
          scheduleId: url.searchParams.get('scheduleId'),
          status: url.searchParams.get('status'),
          limit: Number(url.searchParams.get('limit')) || 50,
          // История автоматизаций листается страницами (AUTO-03D).
          offset: Math.max(Number(url.searchParams.get('offset')) || 0, 0)
        })
      });
    }
    // Компактная сводка запуска (AUTO-03B): отдельный запрос, чтобы история не
    // тянула детали при каждом обновлении списка.
    const invocationSummaryRoute = pathname.match(/^\/api\/invocations\/([^/]+)\/summary$/);
    if (invocationSummaryRoute) {
      if (req.method !== 'GET') {
        return errorJson(res, 405, Object.assign(new Error('Метод не поддерживается.'), { code: 'METHOD_NOT_ALLOWED' }));
      }
      return json(res, 200, manager.invocationSummary(decodeURIComponent(invocationSummaryRoute[1])));
    }
    const invocationRoute = pathname.match(/^\/api\/invocations\/([^/]+)$/);
    if (req.method === 'GET' && invocationRoute) {
      return json(res, 200, manager.getInvocation(decodeURIComponent(invocationRoute[1])));
    }

    const workItemRoute = pathname.match(/^\/api\/work-items\/([^/]+)$/);
    if (workItemRoute) {
      const id = decodeURIComponent(workItemRoute[1]);
      // The item itself carries its sessions: one call is what the screen needs,
      // and a client cannot show a work item without them anyway.
      if (req.method === 'GET') return json(res, 200, manager.workItemDetail(id));
      if (req.method === 'PATCH') return json(res, 200, manager.updateWorkItem(id, await readJson(req).catch(() => ({}))));
      if (req.method === 'DELETE') return json(res, 200, { ok: true, removed: manager.deleteWorkItem(id) });
    }

    const projectSessionsRoute = pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/);
    if (req.method === 'GET' && projectSessionsRoute) {
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
      const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : 0;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        throw Object.assign(new Error('limit — целое от 1 до 500.'), { code: 'INPUT_INVALID' });
      }
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw Object.assign(new Error('offset — целое не меньше нуля.'), { code: 'INPUT_INVALID' });
      }
      return json(res, 200, manager.projectSessions(decodeURIComponent(projectSessionsRoute[1]), {
        query: url.searchParams.get('q'),
        status: url.searchParams.get('status'),
        sort: url.searchParams.get('sort'),
        limit,
        offset
      }));
    }

    const projectPreferencesRoute = pathname.match(/^\/api\/projects\/([^/]+)\/preferences$/);
    if (req.method === 'PATCH' && projectPreferencesRoute) {
      const body = await readJson(req).catch(() => ({}));
      // Only booleans are accepted, and an absent field keeps its stored value: a
      // PATCH of `pinned` must not silently clear `archived`.
      const patch = {};
      for (const key of ['pinned', 'archived']) {
        const value = body?.[key];
        if (value === undefined) continue;
        if (typeof value !== 'boolean') {
          throw Object.assign(new Error('pinned и archived — логические значения.'), { code: 'INPUT_INVALID' });
        }
        patch[key] = value;
      }
      return json(res, 200, manager.setProjectPreferences(decodeURIComponent(projectPreferencesRoute[1]), patch));
    }

    if (req.method === 'GET' && pathname === '/api/quick-actions') {
      const taskId = url.searchParams.get('taskId');
      const runtime = taskId ? manager.runtimes.get(taskId) : null;
      const liveCommands = runtime && !runtime.pi.closed ? await runtime.pi.getCommands().catch(() => []) : [];
      return json(res, 200, await listQuickActions({ rootDir, liveCommands }));
    }

    if (req.method === 'GET' && pathname.startsWith('/api/commands/')) {
      const cmdMatch = pathname.match(/^\/api\/commands\/(.+)$/);
      return json(res, 200, manager.commandStatus(cmdMatch[1]));
    }

    if (req.method === 'POST' && pathname === '/api/uploads') {
      const boundary = multipartBoundary(req.headers['content-type']);
      if (!boundary) throw Object.assign(new Error('Ожидается multipart/form-data с boundary.'), { code: 'INPUT_INVALID' });
      const token = manager.uploads.newToken();
      return json(res, 201, await manager.uploads.receive(req, boundary, token));
    }

    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (req.method === 'DELETE' && projectMatch) {
      manager.removeProject(projectMatch[1]);
      await saveConfig(rootDir, config);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/project-browser') {
      return json(res, 200, await listDirectory(config, url.searchParams.get('path')));
    }
    if (req.method === 'POST' && pathname === '/api/project-browser/register') {
      const body = await readJson(req);
      const resolved = await resolveBrowsablePath(config, body.path);
      const name = String(body.name || path.basename(resolved)).trim().slice(0, 120) || path.basename(resolved);
      const id = uniqueProjectId(manager, name);
      const project = { id, name, path: resolved, useWorktree: false, verification: [] };
      manager.registerProject(project);
      await saveConfig(rootDir, config);
      return json(res, 201, manager.listProjects().find(p => p.id === id));
    }
    if (req.method === 'POST' && pathname === '/api/projects/local-register') {
      if (!access.local(req)) return errorJson(res, 403, Object.assign(new Error('Любую папку можно добавить только на компьютере сервера через localhost.'), { code: 'FORBIDDEN' }));
      const body = await readJson(req);
      const resolved = await resolveLocalProjectPath(body.path);
      const existing = manager.listProjects().find(project => process.platform === 'win32'
        ? project.path?.toLowerCase() === resolved.toLowerCase() : project.path === resolved);
      if (existing) return json(res, 200, existing);
      const name = String(body.name || path.basename(resolved)).trim().slice(0, 120) || path.basename(resolved);
      const id = uniqueProjectId(manager, name);
      manager.registerProject({ id, name, path: resolved, useWorktree: false, verification: [] });
      await saveConfig(rootDir, config);
      return json(res, 201, manager.listProjects().find(project => project.id === id));
    }

    const sessionsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/pi-sessions$/);
    if (req.method === 'GET' && sessionsMatch) return json(res, 200, await manager.nativeSessions.list(sessionsMatch[1]));
    // Native Pi sessions across every project, grouped, with a "likely current"
    // suggestion (§ importer P0). The project-scoped route above stays for
    // compatibility.
    if (req.method === 'GET' && pathname === '/api/native-sessions') {
      return json(res, 200, await manager.nativeSessions.listAll());
    }
    if (req.method === 'GET' && pathname === '/api/native-sessions/preview') {
      return json(res, 200, await manager.nativeSessions.preview({
        projectId: url.searchParams.get('projectId'),
        sessionKey: url.searchParams.get('key')
      }));
    }
    if (req.method === 'POST' && pathname === '/api/tasks/from-session') return json(res, 201, await manager.importSession(await readJson(req)));

    if (req.method === 'GET' && pathname === '/api/tasks') {
      // The list ships every session at once and is the phone's first call: an
      // unbounded per-session field made the body 16.96 MB on 2026-10-13, over
      // the client's 16 MB ceiling, and the sessions screen refused to load
      // (see briefTask). The session itself stays whole at /api/tasks/:id.
      return json(res, 200, manager.listTasks().map(briefTask));
    }

    if (req.method === 'POST' && pathname === '/api/tasks') {
      const body = await readJson(req);
      const { commandId, clientId, ...input } = body;
      const task = await manager.createTask(input, { commandId, clientId, deviceId: access.device(req)?.deviceId });
      return json(res, 202, task);
    }

    const sessionWorkItemsRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/work-items$/);
    if (req.method === 'GET' && sessionWorkItemsRoute) {
      return json(res, 200, { items: manager.workItemsOfSession(decodeURIComponent(sessionWorkItemsRoute[1])) });
    }

    // MR-04, «Session Recap»: what a new session reads instead of the transcript.
    // `recapRoute`, not `match`: `let match` is declared further down this function,
    // and assigning to it here hit its temporal dead zone (500 on every recap call).
    const recapRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/recap$/);
    if (recapRoute) {
      const id = decodeURIComponent(recapRoute[1]);
      if (req.method === 'GET') return json(res, 200, await manager.sessionRecap(id));
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readJson(req);
        return json(res, 200, await manager.saveRecap(id, body.recap ?? body));
      }
      if (req.method === 'DELETE') return json(res, 200, await manager.forgetRecap(id));
    }

    // Follow Plan: status is readable with the flag off (the UI needs to know why
    // the toggle is disabled); every mutating route is a commandId command and a
    // CAS on the plan revision.
    const planRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/plan(?:\/(attach|detach|browse|scan|ai-review|ai-draft|inspect|import|read-file|save-file|content|start|pause|resume|stop|reconcile))?$/);
    if (planRoute) {
      const planTaskId = decodeURIComponent(planRoute[1]);
      const action = planRoute[2] || null;
      if (!manager.getTask(planTaskId)) return errorJson(res, 404, Object.assign(new Error('Session not found'), { code: 'NOT_FOUND' }));
      if (!action && req.method === 'GET') return json(res, 200, await followPlan.status(planTaskId));
      if (action === 'content' && req.method === 'GET') {
        return json(res, 200, await followPlan.content({ taskId: planTaskId }));
      }
      if (action === 'read-file' && req.method === 'GET') {
        // Только чтение выбранного файла проекта: нужно, чтобы оператор мог
        // исправить формат до подключения, не выходя из диалога.
        return json(res, 200, await followPlan.readFile({
          taskId: planTaskId, path: url.searchParams.get('path') || ''
        }));
      }
      if (action === 'browse' && req.method === 'GET') {
        // A read-only listing: one directory per request, no recursive scan, no
        // commandId. It has to be answered before the POST-only guard below —
        // otherwise the phone sees «Not found» (real report, 2026-10-23).
        return json(res, 200, await followPlan.browse({ taskId: planTaskId, path: url.searchParams.get('path') || '' }));
      }
      const body = await readJson(req).catch(() => ({}));
      if (action === 'scan' && req.method === 'POST') {
        // Read-only search of the session workspace (FP-UX-04B): no commandId,
        // no plan write, no Pi. Bounded by plan-scan.mjs, so a huge project
        // answers with `partial: true` instead of hanging.
        return json(res, 200, await followPlan.scan({
          taskId: planTaskId, query: body.query ?? '', limit: body.limit ?? null
        }));
      }
      if (action === 'ai-draft' && req.method === 'POST') {
        // Модель собирает управляемый план из свободного текста; ничего не пишется.
        return json(res, 200, await followPlan.aiDraft({
          taskId: planTaskId, path: body.path ?? null, name: body.name ?? null,
          contentBase64: body.contentBase64 ?? null, hint: body.hint ?? ''
        }));
      }
      if (action === 'ai-review' && req.method === 'POST') {
        // Advisory only: no commandId, no plan write, no Run. The model is asked
        // once, by an explicit click, and its answer never replaces the verdict.
        return json(res, 200, await followPlan.aiReview({
          taskId: planTaskId, path: body.path ?? null, name: body.name ?? null, contentBase64: body.contentBase64 ?? null
        }));
      }
      const command = (fn) => manager.withCommandId(body.commandId, body.clientId, [action || 'patch', planTaskId, body], () => fn());
      if (action === 'save-file') {
        // Правка формата: пишет только валидный управляемый план, CAS по хэшу.
        return json(res, 200, await command(() => followPlan.saveFile({
          taskId: planTaskId, path: body.path, content: body.content,
          expectedHash: body.expectedHash || null, overwrite: body.overwrite === true,
          commandId: body.commandId, clientId: body.clientId
        })));
      }
      if (!action && req.method === 'PATCH') {
        return json(res, 200, await command(() => followPlan.patch({
          taskId: planTaskId, expectedRevision: body.expectedRevision ?? null,
          expectedHash: body.expectedHash || null, changes: body.changes,
          commandId: body.commandId, clientId: body.clientId
        })));
      }
      if (req.method !== 'POST') return errorJson(res, 404, Object.assign(new Error('Not found'), { code: 'NOT_FOUND' }));
      if (action === 'attach') {
        return json(res, 200, await command(() => followPlan.attach({
          taskId: planTaskId, path: body.path, expectedHash: body.expectedHash || null,
          commandId: body.commandId, clientId: body.clientId
        })));
      }
      if (action === 'inspect') {
        // A preview, not a command: nothing is written, so no commandId is spent on it.
        return json(res, 200, await followPlan.inspect({
          taskId: planTaskId, path: body.path ?? null, name: body.name ?? null, contentBase64: body.contentBase64 ?? null
        }));
      }
      if (action === 'content') {
        return json(res, 200, await command(() => followPlan.writeContent({
          taskId: planTaskId, content: body.content, expectedRevision: body.expectedRevision ?? null,
          expectedHash: body.expectedHash || null, allowGoalChange: body.allowGoalChange === true,
          commandId: body.commandId, clientId: body.clientId
        })));
      }
      if (action === 'import') {
        return json(res, 200, await command(() => followPlan.importPlan({
          taskId: planTaskId, path: body.path ?? null, name: body.name ?? null,
          contentBase64: body.contentBase64 ?? null, confirmImport: body.confirmImport === true,
          overwrite: body.overwrite === true, expectedHash: body.expectedHash || null,
          commandId: body.commandId, clientId: body.clientId
        })));
      }
      if (action === 'detach') {
        return json(res, 200, await command(() => followPlan.detach({ taskId: planTaskId, commandId: body.commandId, clientId: body.clientId })));
      }
      if (action === 'start') {
        return json(res, 200, await command(() => followPlan.start({
          taskId: planTaskId, expectedRevision: body.expectedRevision ?? null,
          commandId: body.commandId, clientId: body.clientId
        })));
      }
      if (action === 'pause') {
        return json(res, 200, await command(() => followPlan.pause({ taskId: planTaskId, commandId: body.commandId, clientId: body.clientId })));
      }
      if (action === 'resume') {
        return json(res, 200, await command(() => followPlan.resume({
          taskId: planTaskId, expectedRevision: body.expectedRevision ?? null,
          renewTimeBudget: body.renewTimeBudget === true,
          renewBudget: body.renewBudget === true,
          commandId: body.commandId, clientId: body.clientId
        })));
      }
      if (action === 'stop') {
        return json(res, 200, await command(() => followPlan.stop({ taskId: planTaskId, commandId: body.commandId, clientId: body.clientId })));
      }
      if (action === 'reconcile') {
        return json(res, 200, await command(() => followPlan.reconcile({
          taskId: planTaskId, expectedRevision: body.expectedRevision ?? null, action: body.action,
          commandId: body.commandId, clientId: body.clientId
        })));
      }
    }

    let match = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (req.method === 'GET' && match) {
      const task = manager.getTask(match[1]);
      return task ? json(res, 200, task) : errorJson(res, 404, Object.assign(new Error('Task not found'), { code: 'NOT_FOUND' }));
    }
    if (req.method === 'DELETE' && match) {
      await manager.deleteTask(match[1]);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PATCH' && match) return json(res, 200, await manager.renameTask(match[1], (await readJson(req)).title));

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/events$/);
    if (req.method === 'GET' && match) {
      if (!manager.getTask(match[1])) return errorJson(res, 404, Object.assign(new Error('Session not found'), { code: 'NOT_FOUND' }));
      const after = Number(url.searchParams.get('after') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) throw Object.assign(new Error('Invalid event cursor'), { code: 'INPUT_INVALID' });
      const requested = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 500;
      if (!Number.isSafeInteger(requested) || requested < 0) throw Object.assign(new Error('Invalid event limit'), { code: 'INPUT_INVALID' });
      const limit = requested === 0 ? maxEventsPerRequest : Math.min(requested, maxEventsPerRequest);
      // tail: turn-aligned windowing for paginated history load (see
      // event-window.mjs). Without it, behaves exactly as before — full or
      // limit-sliced history, always used by refreshTask()'s small
      // after-cursor catch-up polls, which don't need windowing.
      if (url.searchParams.has('tail')) {
        const tail = Number(url.searchParams.get('tail'));
        const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null;
        if (!Number.isSafeInteger(tail) || tail <= 0) throw Object.assign(new Error('Invalid tail count'), { code: 'INPUT_INVALID' });
        if (before != null && (!Number.isSafeInteger(before) || before < 0)) throw Object.assign(new Error('Invalid before cursor'), { code: 'INPUT_INVALID' });
        // Read one row more than the slice: the extra row proves events older
        // than the slice exist, so reachedStart can only be true when the read
        // really reached the session start, not just the edge of the slice.
        // With `before` this is also what pages BELOW the cursor at all —
        // reading only the newest `limit` events made everything older
        // unreachable, and "load older" on a long session returned an empty
        // page that looked like the whole history.
        //
        // One slice is not enough for a window: a turn is mostly streaming
        // deltas, so a slice of `limit` events holds far fewer than `tail` turn
        // boundaries and windowByTurns() has nothing to align to. The page then
        // opened in the middle of a message, which the client renders as a
        // partial («Часть истории») turn — a streamed session showed up as a
        // pile of such pieces instead of its turns. So the read walks backwards
        // until more than `tail` turn starts are in hand, the session start is
        // reached, or one of the two ceilings is hit: the per-request event count
        // and the response byte budget (reading past it is pointless — the size
        // cap below keeps only the newest events that fit anyway).
        const chunks = [];
        let hasOlder = false;
        let turns = 0;
        let bytes = 0;
        let size = 0;
        let cursor = before;
        while (true) {
          const slice = await store.readEvents(match[1], limit + 1, after, cursor);
          hasOlder = slice.length > limit;
          const part = hasOlder ? slice.slice(1) : slice;
          if (!part.length) break;
          for (const event of part) bytes += Buffer.byteLength(JSON.stringify(event), 'utf8');
          chunks.push(part);
          size += part.length;
          cursor = part[0].seq;
          turns += part.filter(event => event.type === 'USER_MESSAGE').length;
          if (!hasOlder || turns > tail || size >= maxEventsPerRequest || bytes >= maxHistoryBytes) break;
        }
        const events = trimStreamingDeltas(chunks.reverse().flat());
        const window = windowByTurns(events, tail, before);
        // Also bound by size: a turn (or the events read for it) can be tens of
        // megabytes, which the browser then cannot parse — that is what froze
        // the chat when switching to a very long session. A page cut by size can
        // open mid-turn (no USER_MESSAGE of its own); the client renders what it
        // gets as a partial turn instead of dropping it.
        // The cap keeps the NEWEST event whatever its size — a page has to hold
        // something — so one oversized frame made the response unreadable for a
        // phone: a body over 16 MB is refused with «Ответ сервера слишком большой
        // (16 МБ)» and the session never opened (an `agent_end` frame repeating
        // the whole thread with its base64 images reached 16.3 MB in the real
        // database, 2026-10-13). Every client drops exactly those payloads before
        // rendering (event-trim.mjs), so a window that the budget cannot fit is
        // lightened first: the turn then fits the page whole instead of arriving
        // as the single frame that could not be cut.
        let bounded = capEventsByBytes(window.events, maxHistoryBytes);
        if (pageBytes(bounded) > maxHistoryBytes) bounded = capEventsByBytes(window.events.map(lightenEvent), maxHistoryBytes);
        const cut = bounded.length !== window.events.length;
        return json(res, 200, { events: bounded, reachedStart: window.reachedStart && !hasOlder && !cut });
      }
      const events = trimStreamingDeltas(await store.readEvents(match[1], limit, after));
      return json(res, 200, events);
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/stream$/);
    if (req.method === 'GET' && match) {
      const task = manager.getTask(match[1]);
      if (!task) return errorJson(res, 404, Object.assign(new Error('Task not found'), { code: 'NOT_FOUND' }));
      const after = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0);
      if (!Number.isSafeInteger(after) || after < 0) throw Object.assign(new Error('Invalid event cursor'), { code: 'INPUT_INVALID' });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write('retry: 1500\n\n');
      // Register before reading disk: concurrent live events are buffered until
      // replay is complete, closing the gap between history and subscription.
      const client = addSseClient(match[1], res, after);
      try {
        // Реплей ограничен и числом событий, и БАЙТАМИ — как обычная выдача истории.
        // У большой сессии (20 807 событий / 162 МБ, 2026-10-14) «вся история с
        // нуля» — это сотни мегабайт на каждое переподключение: очередь
        // backpressure переполнялась мгновенно, стрим рвался по лимиту, а клиент
        // переподключался и повторял это бесконечно (телефон показывал «поток
        // событий оборван»). Обрезанный реплей — это ровно то же, что уже делает
        // обычная страница истории; клиент узнаёт об обрезке из `: replay-trimmed`
        // и берёт старое через /events?before=, как делал и раньше.
        const raw = await (typeof store.readEventsForward === 'function'
          ? store.readEventsForward(match[1], maxEventsPerRequest, after)
          : store.readEvents(match[1], maxEventsPerRequest, after));
        const history = capEventsByBytes(raw, maxHistoryBytes);
        if (history.length !== raw.length) {
          try { res.write(`: replay-trimmed ${raw.length - history.length}\n\n`); } catch { /* сокет закрыт */ }
        }
        for (const event of history) {
          if (!deliver(client, event)) break;
          // Отдаём историю медленному клиенту порциями: ждём сокет, а не копим
          // события в памяти и не рвём соединение.
          await client.writer.waitForDrain();
        }
        for (const event of client.pending.sort((a, b) => a.seq - b.seq)) {
          if (!deliver(client, event)) break;
          await client.writer.waitForDrain();
        }
        client.pending = [];
        client.replaying = false;
      } catch { res.end(); }
      return;
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/state$/);
    if (req.method === 'GET' && match) {
      return json(res, 200, { state: await manager.state(match[1]) });
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/runs$/);
    if (req.method === 'GET' && match) {
      return json(res, 200, { runs: manager.listRuns(match[1], Number(url.searchParams.get('limit')) || 50) });
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && match) {
      const c = await readJson(req);
      return json(res, 200, await manager.cancel(match[1], { commandId: c.commandId, clientId: c.clientId, hard: c.hard === true }));
    }

    // Erase every message of a session, keeping the session itself. Destructive,
    // so the body must say `confirm: true` (also keeps the contract probe safe).
    match = pathname.match(/^\/api\/tasks\/([^/]+)\/clear$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req).catch(() => ({}));
      if (body?.confirm !== true) throw Object.assign(new Error('Очистка чата требует подтверждения (confirm: true).'), { code: 'INPUT_INVALID' });
      return json(res, 200, await manager.clearConversation(match[1]));
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/message$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req);
      // now: true is "send immediately, do not wait for the local model" (the
      // Ctrl+Enter path); otherwise a busy model means the prompt is queued.
      return json(res, 200, await manager.message(match[1], body.text, body.mode || 'auto', body.files || [], body.uploadToken,
        { now: body.now === true, queue: body.queue === true, commandId: body.commandId, clientId: body.clientId, deviceId: access.device(req)?.deviceId }));
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/turns\/([^/]+)$/);
    if (req.method === 'DELETE' && match) return json(res, 200, await manager.deleteTurns(match[1], decodeURIComponent(match[2])));
    if (req.method === 'PATCH' && match) {
      const body = await readJson(req);
      return json(res, 200, await manager.editTurn(match[1], { turnId: decodeURIComponent(match[2]), text: body.text }));
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/undo-last-turn$/);
    if (req.method === 'POST' && match) return json(res, 200, await manager.undoLastTurn(match[1]));

    // In-place correction of an already settled message: the record is fixed,
    // the model is NOT asked again and no answer is regenerated. branch: true
    // turns the edited answer into another variant of the same exchange.
    match = pathname.match(/^\/api\/tasks\/([^/]+)\/turns\/([^/]+)\/edit$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req);
      return json(res, 200, await manager.editTurn(match[1], {
        turnId: decodeURIComponent(match[2]), text: body.text, branch: body.branch === true
      }));
    }

    // "Continue": the newest answer is asked to go on, and what the model writes
    // next is appended to that same message.
    match = pathname.match(/^\/api\/tasks\/([^/]+)\/continue$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req);
      return json(res, 200, await manager.continueTurn(match[1], body.turnId));
    }

    // A message and everything that came after it. The log is linear, so a
    // later branch cannot survive its parent; the client warns with the
    // affected count before calling this.
    match = pathname.match(/^\/api\/tasks\/([^/]+)\/turns\/([^/]+)\/delete$/);
    if (req.method === 'POST' && match) return json(res, 200, await manager.deleteTurns(match[1], decodeURIComponent(match[2])));

    // Regenerate: the same question is put to the model again as another answer
    // of the same exchange — the previous one stays in history as a sibling.
    match = pathname.match(/^\/api\/tasks\/([^/]+)\/regenerate$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req);
      return json(res, 200, await manager.regenerateLastTurn(match[1], body.turnId));
    }

    // Повторить с параметрами (MR-07): модель и уровень мышления применяются к
    // сессии, затем тот же вопрос уходит заново — как regenerate, но с выбором
    // «чем отвечать» в одном вызове.
    match = pathname.match(/^\/api\/tasks\/([^/]+)\/rerun$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req);
      return json(res, 200, await manager.rerunLastTurn(match[1], {
        turnId: body.turnId,
        model: body.model || null,
        thinkingLevel: body.thinkingLevel || null,
      }));
    }

    // Switching between the answers of one exchange: a reading preference, so
    // nothing is rewritten and no model is asked.
    match = pathname.match(/^\/api\/tasks\/([^/]+)\/variant$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req);
      return json(res, 200, await manager.selectVariant(match[1], { turnSeq: body.turnSeq, variantId: body.variantId }));
    }

    // Fork: a new session in the same project whose conversation is a copy of
    // this one. `direction: 'from'` copies the chosen message and everything
    // after it instead of the history up to it; the source is left untouched.
    match = pathname.match(/^\/api\/tasks\/([^/]+)\/fork$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req);
      return json(res, 201, await manager.forkTask(match[1], body.turnId, body.direction));
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/pending\/send$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req);
      return json(res, 200, await manager.sendPendingNow(match[1], body.pendingId || null));
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/pending$/);
    if (req.method === 'DELETE' && match) return json(res, 200, await manager.dropPending(match[1], url.searchParams.get('pendingId')));

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/model$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req);
      return json(res, 200, await manager.setModel(match[1], body.provider, body.id || body.modelId));
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/thinking$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req);
      return json(res, 200, await manager.setThinkingLevel(match[1], body.level));
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/auto-compaction$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req);
      return json(res, 200, await manager.setAutoCompaction(match[1], body.enabled));
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/compact$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req);
      return json(res, 200, { result: await manager.compact(match[1], body.instructions || '') });
    }

    // Persist Pi's project trust decision. This changes which project-local
    // resources Pi may load, so it is explicit and retires the current Pi.
    match = pathname.match(/^\/api\/tasks\/([^/]+)\/workspace\/trust$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req).catch(() => ({}));
      if (body?.confirm !== true) throw Object.assign(new Error('Доверие к папке требует подтверждения (confirm: true).'), { code: 'INPUT_INVALID' });
      return json(res, 200, await manager.trustWorkspace(match[1]));
    }

    // «Перезапустить сессию»: kill the session's Pi, the next message restarts
    // it from the saved session file. The routine exit for a hung session.
    match = pathname.match(/^\/api\/tasks\/([^/]+)\/session\/restart$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req).catch(() => ({}));
      // The task itself, not { result }: the client parses the response as a
      // Task, and a wrapper made every restart answer "Field 'id' is required"
      // while the restart had already run server-side.
      return json(res, 200, await manager.restartSession(match[1]));
    }

    // «Откуда контекст»: разбор запроса к модели по источникам (системный
    // промпт, инструкции проекта, навыки, MCP-инструменты, история) плюс числа
    // самого Pi. Читает с диска и из запущенного Pi, ничего не меняет.
    match = pathname.match(/^\/api\/tasks\/([^/]+)\/context\/summary$/);
    if (req.method === 'GET' && match) return json(res, 200, await manager.contextSummary(match[1]));
    match = pathname.match(/^\/api\/tasks\/([^/]+)\/context$/);
    if (req.method === 'GET' && match) return json(res, 200, await manager.contextReport(match[1]));
    // Лимит контекста этой сессии: верхняя граница, после которой TaskBridge сам
    // сжимает историю (см. task-manager #enforceContextLimit). `limit: null` — снять.
    if (req.method === 'POST' && match) {
      const body = await readJson(req);
      return json(res, 200, await manager.setContextLimit(match[1], body.limit));
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/apply$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req).catch(() => ({}));
      return json(res, 200, await manager.applyTask(match[1], { force: body.force === true, commandId: body.commandId, clientId: body.clientId }));
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/worktree$/);
    if (req.method === 'DELETE' && match) return json(res, 200, await manager.cleanupWorktree(match[1]));

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/artifacts$/);
    if (req.method === 'GET' && match) {
      return json(res, 200, await listArtifacts(match[1]));
    }

    // Сколько места сессия занимает на диске компьютера (артефакты, вложения,
    // рабочая копия, нативная сессия pi). Только измерение: ничего не удаляет и не
    // ограничивает; клиент показывает предупреждение по флагу `warn`.
    match = pathname.match(/^\/api\/tasks\/([^/]+)\/storage$/);
    if (req.method === 'GET' && match) {
      if (!manager.getTask(match[1])) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
      const measured = await sessionStorage({ dataRoot, taskId: match[1] });
      const thresholdBytes = warnSessionBytes(config);
      return json(res, 200, { ...measured, thresholdBytes, warn: measured.bytes >= thresholdBytes });
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/approvals$/);
    if (req.method === 'GET' && match) {
      if (!manager.getTask(match[1])) return errorJson(res, 404, Object.assign(new Error('Session not found'), { code: 'NOT_FOUND' }));
      return json(res, 200, manager.listApprovals(match[1]));
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/approvals\/([^/]+)$/);
    if (req.method === 'POST' && match) {
      const body = await readJson(req);
      const decision = String(body.decision || '');
      if (!['ALLOW_ONCE', 'DENY'].includes(decision)) throw Object.assign(new Error('Неизвестное решение по подтверждению.'), { code: 'INPUT_INVALID' });
      if (!manager.resolveApproval(match[1], match[2], decision)) {
        return errorJson(res, 404, Object.assign(new Error('Запрос подтверждения уже неактуален.'), { code: 'NOT_FOUND' }));
      }
      return json(res, 200, { ok: true, approvalId: match[2], decision });
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/tools\/([^/]+)\/output$/);
    if (req.method === 'GET' && match) {
      if (!manager.getTask(match[1])) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
      const maxKb = Number(url.searchParams.get('maxKb') || 0);
      const result = await manager.fetchToolOutput(match[1], match[2], maxKb > 0 ? { maxBytes: maxKb * 1024 } : {});
      return json(res, 200, result);
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/files(?:\/([a-f0-9-]{36}))?$/);
    if (['GET', 'HEAD'].includes(req.method) && match) {
      const task = manager.getTask(match[1]);
      if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
      const files = [...(task.attachments || []), ...(task.outputFiles || [])];
      if (!match[2]) return json(res, 200, files);
      const file = files.find(f => f.id === match[2]);
      if (!file) throw Object.assign(new Error('Файл не найден.'), { code: 'NOT_FOUND' });
      const target = await containedFile(path.join(store.taskDir(task.id), 'files'), file.id, { allowPrivate: true });
      await serveFile(req, res, target, file.name, url.searchParams.get('download') === '1');
      return;
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/artifacts\/([^/]+)$/);
    if (['GET', 'HEAD'].includes(req.method) && match) {
      if (!manager.getTask(match[1])) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
      const name = path.basename(match[2]);
      const target = await containedFile(path.join(store.taskDir(match[1]), 'artifacts'), name);
      await serveFile(req, res, target, name, url.searchParams.get('download') === '1');
      return;
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/workspace-file$/);
    if (['GET', 'HEAD'].includes(req.method) && match) {
      const task = manager.getTask(match[1]);
      if (!task?.workspacePath) throw Object.assign(new Error('Рабочая папка не найдена.'), { code: 'NOT_FOUND' });
      const requestedPath = String(url.searchParams.get('path') || '');
      let target;
      try {
        target = await containedFile(task.workspacePath, requestedPath);
      } catch (error) {
        if (error.code !== 'INPUT_INVALID') throw error;
        target = await observedToolFile(task.id, requestedPath, task.workspacePath);
      }
      const range = lineRangeParams(url);
      if (range) await serveFileLineRange(res, target, path.basename(target), range);
      else await serveFile(req, res, target, path.basename(target), url.searchParams.get('download') === '1');
      return;
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/changed-files$/);
    if (['GET', 'HEAD'].includes(req.method) && match) {
      const task = manager.getTask(match[1]);
      if (!task?.workspacePath) throw Object.assign(new Error('Рабочая папка не найдена.'), { code: 'NOT_FOUND' });
      const state = await collectGitState(task.workspacePath);
      return json(res, 200, {
        taskId: task.id,
        isGit: state.isGit,
        changedFiles: state.changedFiles || [],
        status: state.status || '',
        truncated: /omitted/u.test(state.status || ''),
      });
    }

    // --- list the task workspace (relative paths for @-references in a prompt) ---
    match = pathname.match(/^\/api\/tasks\/([^/]+)\/workspace-files$/);
    if (['GET', 'HEAD'].includes(req.method) && match) {
      const task = manager.getTask(match[1]);
      if (!task?.workspacePath) throw Object.assign(new Error('Рабочая папка не найдена.'), { code: 'NOT_FOUND' });
      return json(res, 200, await listWorkspaceFiles(task.workspacePath));
    }

    // --- open on the machine (browser cannot start an app; the machine can) ---
    // Clicking a file on the PC opens it with the program registered for its
    // extension (or reveals it in the file manager). That is an action on the
    // computer, so it is allowed only for a request whose client address is the
    // machine itself (loopback, or one of this host's own addresses — see
    // AccessControl.machine). A phone on the LAN does not qualify. A body flag
    // is required, too: without it the contract probe in
    // tests/api-contract.test.mjs would launch windows on the build machine.
    const assertMachineLocal = (message = 'Открыть файл приложением можно только с самого компьютера.') => {
      if (!access.machine(req)) throw Object.assign(new Error(message), { code: 'FILE_OPEN_LOCAL_ONLY' });
    };
    // Running is also allowed to an authenticated client (a paired phone): the PC
    // does the work and the phone reads the output, which is the point of a
    // remote session. Opening files with desktop apps stays machine-only, since
    // nobody but the operator at the PC would see that.
    const assertCanExecute = () => {
      if (!access.machine(req) && !access.authenticated(req)) throw Object.assign(new Error('Выполнение на компьютере недоступно этому клиенту.'), { code: 'MACHINE_ACTION_FORBIDDEN' });
    };
    const openConfirmed = async () => {
      const body = await readJson(req).catch(() => ({}));
      if (body?.confirm !== true) throw Object.assign(new Error('Открытие файла требует подтверждения (confirm: true).'), { code: 'INPUT_INVALID' });
      return body;
    };
    // Prefer the workspace copy of an attachment: it carries the real name and
    // extension, so the OS association is right. The stored copy is a bare id
    // with no extension and would not open in any application.
    const attachmentPath = async (task, file) => {
      if (task.workspacePath && file.path) {
        const copy = await containedFile(task.workspacePath, file.path, { allowPrivate: true }).catch(() => null);
        if (copy) return copy;
      }
      return containedFile(path.join(store.taskDir(task.id), 'files'), file.id, { allowPrivate: true });
    };

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/files\/([a-f0-9-]{36})\/open$/);
    if (req.method === 'POST' && match) {
      assertMachineLocal();
      const body = await openConfirmed();
      const task = manager.getTask(match[1]);
      if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
      const file = [...(task.attachments || []), ...(task.outputFiles || [])].find(f => f.id === match[2]);
      if (!file) throw Object.assign(new Error('Файл не найден.'), { code: 'NOT_FOUND' });
      await openLocalPath(await attachmentPath(task, file), { reveal: body.reveal === true });
      return json(res, 200, { opened: true, reveal: body.reveal === true, name: file.name });
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/artifacts\/([^/]+)\/open$/);
    if (req.method === 'POST' && match) {
      assertMachineLocal();
      const body = await openConfirmed();
      if (!manager.getTask(match[1])) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
      const name = path.basename(match[2]);
      await openLocalPath(await containedFile(path.join(store.taskDir(match[1]), 'artifacts'), name), { reveal: body.reveal === true });
      return json(res, 200, { opened: true, reveal: body.reveal === true, name });
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/workspace-file\/open$/);
    if (req.method === 'POST' && match) {
      assertMachineLocal();
      const body = await openConfirmed();
      const task = manager.getTask(match[1]);
      if (!task?.workspacePath) throw Object.assign(new Error('Рабочая папка не найдена.'), { code: 'NOT_FOUND' });
      // The path travels in the query string, exactly as the GET route reads it.
      // Reading it from the body left it empty, so the target resolved to the
      // workspace folder and "reveal" opened the folder instead of the file.
      const requestedPath = workspacePathQuery(url, body);
      let target;
      let reveal = body.reveal === true;
      try {
        target = await containedFile(task.workspacePath, requestedPath);
      } catch (error) {
        if (error.code === 'INPUT_INVALID') {
          target = await observedToolFile(task.id, requestedPath);
        } else {
          // The file viewer can outlive scratch files the agent rewrites/deletes
          // (image frames are the common case). «Open in app» must still 404, but
          // «Show in folder» can open the nearest surviving containing folder.
          if (!reveal || error.code !== 'NOT_FOUND') throw error;
          target = await containedExistingAncestor(task.workspacePath, requestedPath);
          reveal = false;
        }
      }
      await openLocalPath(target, { reveal });
      return json(res, 200, { opened: true, reveal: body.reveal === true, name: path.basename(target) });
    }

    // Открыть папку, в которой работает сессия, файловым менеджером. Как и у
    // остальных маршрутов «открыть на машине»: подтверждение обязательно (иначе
    // контрактный проб в tests/api-contract.test.mjs открывал бы окна на сборочной
    // машине), и доступно только тому клиенту, чей адрес — сама машина (окно на
    // экране оператора, а не на телефоне). Свежая сессия папки ещё не имеет —
    // тогда честный 404, а не открытие каталога задачи.
    match = pathname.match(/^\/api\/tasks\/([^/]+)\/workspace\/open$/);
    if (req.method === 'POST' && match) {
      assertMachineLocal('Открыть папку сессии можно только на самом компьютере.');
      await openConfirmed();
      const task = manager.getTask(match[1]);
      if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
      const folder = task.workspacePath ? await fs.realpath(task.workspacePath).catch(() => null) : null;
      if (!folder) throw Object.assign(new Error('Рабочая папка не найдена.'), { code: 'NOT_FOUND' });
      await openLocalPath(folder);
      return json(res, 200, { opened: true, name: path.basename(folder), path: folder });
    }

    // Run a script on the machine. Same guards as opening (machine only,
    // confirmation required); the output and exit code come back to the UI.
    match = pathname.match(/^\/api\/tasks\/([^/]+)\/files\/([a-f0-9-]{36})\/run$/);
    if (req.method === 'POST' && match) {
      assertCanExecute();
      await openConfirmed();
      const task = manager.getTask(match[1]);
      if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
      const file = [...(task.attachments || []), ...(task.outputFiles || [])].find(f => f.id === match[2]);
      if (!file) throw Object.assign(new Error('Файл не найден.'), { code: 'NOT_FOUND' });
      return json(res, 200, { ...await runLocalScript(await attachmentPath(task, file)), name: file.name });
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/artifacts\/([^/]+)\/run$/);
    if (req.method === 'POST' && match) {
      assertCanExecute();
      await openConfirmed();
      if (!manager.getTask(match[1])) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
      const name = path.basename(match[2]);
      const target = await containedFile(path.join(store.taskDir(match[1]), 'artifacts'), name);
      return json(res, 200, { ...await runLocalScript(target), name });
    }

    match = pathname.match(/^\/api\/tasks\/([^/]+)\/workspace-file\/run$/);
    if (req.method === 'POST' && match) {
      assertCanExecute();
      const body = await openConfirmed();
      const task = manager.getTask(match[1]);
      if (!task?.workspacePath) throw Object.assign(new Error('Рабочая папка не найдена.'), { code: 'NOT_FOUND' });
      const target = await containedFile(task.workspacePath, workspacePathQuery(url, body));
      return json(res, 200, { ...await runLocalScript(target), name: path.basename(target) });
    }

    // Run a shell command line (a fenced command block the operator chose) in the
    // session workspace. Confirmation is required; running is allowed on the
    // machine and for an authenticated client (a paired phone).
    match = pathname.match(/^\/api\/tasks\/([^/]+)\/shell$/);
    if (req.method === 'POST' && match) {
      assertCanExecute();
      const body = await openConfirmed();
      const task = manager.getTask(match[1]);
      if (!task) throw Object.assign(new Error('Сессия не найдена.'), { code: 'NOT_FOUND' });
      const cwd = task.workspacePath ? await fs.realpath(task.workspacePath).catch(() => null) : null;
      const result = await runShellCommand(String(body.command || ''), { cwd: cwd || rootDir });
      return json(res, 200, await boundShellOutput(result, task.id));
    }

    if (req.method === 'GET' && await serveStatic(pathname, res)) return;
    errorJson(res, 404, Object.assign(new Error('Not found'), { code: 'NOT_FOUND' }));
  } catch (error) {
    if (res.headersSent) { res.destroy(); return; }
    // The proxy's request id makes its 502 and this line the same event: without
    // it «the app hung up» and «the socket died» look identical in two logs.
    console.error(`[${req.headers['x-taskbridge-request-id'] || '-'}] ${error.message}`);
    const status = error.code === 'BODY_TOO_LARGE' ? 413
      : ['INPUT_INVALID', 'PROJECT_DIRTY', 'NOT_CONFIGURED', 'MODEL_NOT_FOUND', 'LOCAL_HTTP_ERROR', 'LOCAL_NOT_ROUTER', 'LOCAL_LOAD_FAILED', 'LOCAL_CONTEXT_UNSUPPORTED', 'SCRIPT_NOT_RUNNABLE', 'PLAN_INVALID'].includes(error.code) ? 400
      // CONFLICT / UNKNOWN_AFTER_CRASH / ACCEPTED come from the commandId journal.
      // They are answers about that command, not server faults: a 5xx would make
      // a retrying client treat them as an outage. ACCEPTED (still in flight) is
      // the one worth repeating later — the repeat returns the saved result.
      : ['BUSY', 'MODEL_BUSY', 'SESSION_UNAVAILABLE', 'SESSION_INVALID', 'SOURCE_MOVED', 'NOTHING_TO_APPLY', 'CONFLICT', 'UNKNOWN_AFTER_CRASH', 'ACCEPTED', 'NOT_ALLOWED', 'CONTEXT_CHANGED',
        // Follow Plan: these are answers about the plan, not server faults.
        'PLAN_BUSY', 'PLAN_BLOCKED', 'PLAN_CHECKPOINT_REJECTED', 'PLAN_REVISION_CONFLICT', 'PLAN_BUDGET_EXCEEDED', 'PLAN_NO_PROGRESS', 'PLAN_UNKNOWN_OUTCOME', 'FOLLOW_PLAN_DISABLED', 'PLAN_FILE_EXISTS'].includes(error.code) ? 409
      : error.code === 'AUTH_REQUIRED' ? 401
      : ['FILE_FORBIDDEN', 'ORIGIN_FORBIDDEN', 'FILE_OPEN_LOCAL_ONLY', 'MACHINE_ACTION_FORBIDDEN'].includes(error.code) ? 403
      : error.code === 'RATE_LIMITED' ? 429
      // PROJECT_NOT_FOUND is a 404, not a 400: the request is well-formed, the
      // thing it names is not there (a work item must belong to a known project).
      : ['NOT_FOUND', 'ENOENT', 'PROJECT_NOT_FOUND', 'SESSION_NOT_FOUND', 'PLAN_NOT_ATTACHED'].includes(error.code) ? 404
      : 500;
    errorJson(res, status, error);
  }
}

// In the split launch the app binds loopback and the proxy owns the LAN side, so
// "is the LAN open" follows the configured host, not the bound one.
const lanOpen = lanAllowed(config.server?.host || '0.0.0.0', config.server?.auth);
const requestedHost = bindHostOverride || config.server?.host || '0.0.0.0';
const host = lanAllowed(requestedHost, config.server?.auth) ? requestedHost : '127.0.0.1';
if (!lanOpen) console.warn(LAN_CLOSED_WARNING);
const port = portOverride || Number(config.server?.port || 8787);
// What the UI prints. Behind the proxy the bound port is the internal one, which
// no phone can reach — the public port is the proxy's.
const publicPort = publicPortOverride || port;
const server = http.createServer(handleRequest);
server.listen(port, host, () => {
  console.log(`\nTaskBridge MVP listening on ${host}:${port}`);
  console.log(`Local: http://127.0.0.1:${port}`);
  if (lanOpen) for (const item of lanAddresses(publicPort)) console.log(`LAN (${item.interface}): ${item.url}`);
  console.log(access.enabled ? '\nPairing enabled. Open localhost and click «Подключить телефон» for a code.\n' : '\nPairing disabled by configuration.\n');
});

if (httpsConfig.enabled && !tlsDisabled) {
  const httpsPort = Number(httpsConfig.port || 8443);
  try {
    const { key, cert, certPath } = await ensureTlsCert(dataRoot);
    https.createServer({ key, cert }, handleRequest).listen(httpsPort, host, () => {
      console.log(`HTTPS listening on ${host}:${httpsPort} (self-signed cert: ${certPath})`);
      if (lanOpen) for (const item of lanAddresses(httpsPort, 'https')) console.log(`LAN HTTPS (${item.interface}): ${item.url}`);
      console.log('Self-signed certificate: the browser will warn "not secure" once per device until you accept it.\n');
    });
  } catch (error) {
    console.error(`HTTPS disabled: failed to prepare certificate (${error.message}). Is 'openssl' on PATH?`);
  }
}
