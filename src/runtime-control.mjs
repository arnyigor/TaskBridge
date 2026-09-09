import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = (code, message) => Object.assign(new Error(message), { code });

function localEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('RUNTIME_EXTERNAL_UNSAFE', 'Не задан локальный адрес модели.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw failure('RUNTIME_EXTERNAL_UNSAFE', 'Перезапуск разрешён только для модели на этом компьютере.');
  }
  return { port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
}

const discoveryScript = `
$ErrorActionPreference = 'Stop'
$listenerIds = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$env:TASKBRIDGE_RUNTIME_PORT) -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
if ($listenerIds.Count -eq 0) { Write-Output 'null'; exit 0 }
if ($listenerIds.Count -ne 1) { throw 'More than one process listens on the model port' }
$modelProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$listenerIds[0])
if (!$modelProcess -or !$modelProcess.ExecutablePath -or !$modelProcess.CreationDate) { throw 'Cannot identify the listening process' }
@{ pid = [int]$modelProcess.ProcessId; executablePath = $modelProcess.ExecutablePath; creationDate = $modelProcess.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
`;

async function powershell(script, environment) {
  return execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024,
    env: { ...process.env, ...environment }
  });
}

async function discoverWindows(endpoint) {
  const { stdout } = await powershell(discoveryScript, { TASKBRIDGE_RUNTIME_PORT: String(endpoint.port) });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
}

async function stopWindowsExternal(identity, endpoint) {
  // Recheck the listener and process creation time in the same invocation that
  // stops it. Never terminate a parent GUI or use a process-name wildcard.
  await powershell(`
$ErrorActionPreference = 'Stop'
$expectedId = [int]$env:TASKBRIDGE_RUNTIME_PID
$listenerIds = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$env:TASKBRIDGE_RUNTIME_PORT) -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
if ($listenerIds.Count -ne 1 -or $listenerIds[0] -ne $expectedId) { throw 'Model listener identity changed' }
$modelProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $expectedId)
if (!$modelProcess -or $modelProcess.ExecutablePath -ine $env:TASKBRIDGE_RUNTIME_EXE -or $modelProcess.CreationDate.ToUniversalTime().ToString('o') -cne $env:TASKBRIDGE_RUNTIME_CREATED) { throw 'Model process identity changed' }
Stop-Process -Id $expectedId -Force -ErrorAction Stop
`, {
    TASKBRIDGE_RUNTIME_PORT: String(endpoint.port), TASKBRIDGE_RUNTIME_PID: String(identity.pid),
    TASKBRIDGE_RUNTIME_EXE: identity.executablePath, TASKBRIDGE_RUNTIME_CREATED: identity.creationDate
  });
}

function closed(proc) { return !proc || proc.exitCode != null || proc.signalCode != null; }

async function waitClosed(proc, milliseconds) {
  if (closed(proc)) return true;
  return new Promise(resolve => {
    const finish = result => { clearTimeout(timer); proc.removeListener('close', onClose); resolve(result); };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), milliseconds);
    proc.once('close', onClose);
    if (closed(proc)) finish(true);
  });
}

async function stopManaged(proc, platform) {
  if (closed(proc)) return;
  if (!Number.isSafeInteger(proc.pid) || proc.pid <= 0) throw failure('RUNTIME_STOP_FAILED', 'Неизвестен PID процесса модели.');
  if (platform === 'win32') {
    await execute('taskkill.exe', ['/PID', String(proc.pid)], { windowsHide: true, timeout: 5000 }).catch(() => {});
  } else proc.kill('SIGTERM');
  if (await waitClosed(proc, 3000)) return;
  if (platform === 'win32') {
    await execute('taskkill.exe', ['/PID', String(proc.pid), '/F'], { windowsHide: true, timeout: 5000 });
  } else proc.kill('SIGKILL');
  if (!await waitClosed(proc, 5000)) throw failure('RUNTIME_STOP_FAILED', 'Процесс модели не завершился.');
}

export class RuntimeControl {
  constructor(runtime, manager, options = {}) {
    this.runtime = runtime;
    this.manager = manager;
    this.platform = options.platform || process.platform;
    this.discover = options.discover || discoverWindows;
    this.stopExternal = options.stopExternal || stopWindowsExternal;
    this.stopManaged = options.stopManaged || (proc => stopManaged(proc, this.platform));
    this.realpath = options.realpath || fs.realpath;
    this.sleep = options.sleep || pause;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 10000;
    this.closePi = options.closePi || (async pi => {
      const proc = pi.proc;
      pi.closeStdin();
      if (proc && !await waitClosed(proc, 2500)) {
        await pi.killTree();
        if (!await waitClosed(proc, 3000)) throw failure('RUNTIME_STOP_FAILED', 'Не удалось закрыть процесс Pi.');
      }
    });
    this.operation = null;
    this.lastError = null;
  }

  profiles() {
    const configured = this.runtime.config.profiles || [];
    return Array.isArray(configured) ? configured : Object.entries(configured).map(([id, profile]) => ({ ...profile, id }));
  }

  target(profileId) {
    const profiles = this.profiles();
    const id = profileId || this.runtime.config.defaultProfile || profiles[0]?.id;
    const profile = profiles.find(item => item.id === id);
    if (!profile || profile.enabled === false || !profile.command) throw failure('INPUT_INVALID', 'Неизвестный или отключённый профиль модели.');
    return profile;
  }

  assertAdmissionIdle() {
    if (this.manager.activeTaskId || this.manager.admitting) throw failure('BUSY', 'Дождитесь завершения текущего запроса перед перезапуском модели.');
  }

  async assertIdle() {
    this.assertAdmissionIdle();
    for (const entry of this.manager.runtimes.values()) {
      if (entry.pi.closed) continue;
      const state = await entry.pi.getState().catch(() => null);
      if (!state) throw failure('BUSY', 'Не удалось проверить состояние Pi. Перезапуск отложен.');
      if (state.isStreaming || state.isCompacting || entry.verifying) throw failure('BUSY', 'Pi ещё работает. Дождитесь завершения ответа или сжатия контекста.');
    }
    if (await this.runtime.isReady()) {
      const busy = await this.runtime.getBusyStatus();
      if (busy.unknown || busy.busy) throw failure('BUSY', busy.unknown ? 'Не удалось подтвердить, что модель свободна.' : 'Модель обрабатывает запрос. Дождитесь завершения.');
    }
    this.assertAdmissionIdle();
  }

  async identifyExternal() {
    const endpoint = localEndpoint(this.runtime.config.healthUrl);
    if (this.platform !== 'win32') throw failure('RUNTIME_EXTERNAL_UNSAFE', 'Внешнюю модель нужно остановить в приложении, которое её запустило.');
    const identity = await this.discover(endpoint);
    if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !identity.creationDate || !identity.executablePath) {
      throw failure('RUNTIME_EXTERNAL_UNSAFE', 'Не удалось надёжно определить процесс модели.');
    }
    const normalize = async value => (await this.realpath(value)).replaceAll('\\', '/').toLowerCase();
    let executable;
    try { executable = await normalize(identity.executablePath); }
    catch { throw failure('RUNTIME_EXTERNAL_UNSAFE', 'Не удалось проверить исполняемый файл модели.'); }
    let allowed = false;
    for (const profile of this.profiles()) {
      if (!profile.command || profile.enabled === false) continue;
      const command = path.isAbsolute(profile.command) ? profile.command : path.resolve(profile.cwd || process.cwd(), profile.command);
      if (await normalize(command).catch(() => null) === executable) allowed = true;
    }
    if (!allowed) throw failure('RUNTIME_EXTERNAL_UNSAFE', 'Порт занят другим приложением. Его исполняемый файл не совпадает с профилями модели.');
    return { identity, endpoint };
  }

  async status() {
    const status = await this.runtime.getStatus();
    const error = this.lastError?.message || status.error || null;
    if (this.operation) return { ...status, error, state: 'RESTARTING', canRestart: false, externalRestartReason: 'Модель перезапускается.' };
    let externalRestartReason = null;
    try {
      this.target();
      if (this.runtime.state === 'STARTING') throw failure('BUSY', 'Модель запускается.');
      await this.assertIdle();
      if (!this.runtime.proc && await this.runtime.isReady()) await this.identifyExternal();
    } catch (error) { externalRestartReason = error.message; }
    return { ...status, error, canRestart: !externalRestartReason, externalRestartReason };
  }

  restart(profileId) {
    // Set admission lock synchronously so two requests cannot both begin.
    if (this.operation || this.manager.runtimeChanging || ['STARTING', 'RESTARTING'].includes(this.runtime.state)) {
      return Promise.reject(failure('BUSY', 'Уже выполняется запуск или перезапуск модели.'));
    }
    let profile;
    try { profile = this.target(profileId); this.assertAdmissionIdle(); }
    catch (error) { return Promise.reject(error); }
    this.lastError = null;
    this.manager.runtimeChanging = true;
    this.operation = this.performRestart(profile).catch(error => {
      this.lastError = error;
      throw error;
    }).finally(() => {
      this.manager.runtimeChanging = false;
      this.operation = null;
    });
    return this.operation;
  }

  async performRestart(profile) {
    await this.assertIdle();
    const proc = this.runtime.proc;
    const ready = await this.runtime.isReady();
    const local = this.platform === 'win32' ? localEndpoint(this.runtime.config.healthUrl) : null;
    let external = null;
    if (!proc && ready) external = await this.identifyExternal();
    // Even an unhealthy/loading external listener must never be replaced blindly.
    if (!proc && !ready && this.platform === 'win32') {
      const endpoint = localEndpoint(this.runtime.config.healthUrl);
      if (await this.discover(endpoint)) throw failure('RUNTIME_EXTERNAL_UNSAFE', 'Порт модели занят, но состояние процесса неизвестно. Остановите его в исходном приложении.');
    }
    await this.assertIdle();
    if (proc) {
      if (this.runtime.proc !== proc || !Number.isSafeInteger(proc.pid)) throw failure('RUNTIME_STOP_FAILED', 'Процесс модели изменился во время проверки.');
      const listener = local ? await this.discover(local) : null;
      if (listener && listener.pid !== proc.pid) throw failure('RUNTIME_EXTERNAL_UNSAFE', 'Порт занят другим процессом. Перезапуск отменён.');
      await this.assertIdle();
      await this.stopManaged(proc);
    } else if (external) {
      const checked = await this.identifyExternal();
      if (checked.identity.pid !== external.identity.pid || checked.identity.creationDate !== external.identity.creationDate || checked.identity.executablePath !== external.identity.executablePath) {
        throw failure('RUNTIME_EXTERNAL_UNSAFE', 'Процесс модели изменился во время проверки. Повторите попытку.');
      }
      await this.assertIdle();
      await this.stopExternal(external.identity, external.endpoint);
    }
    const deadline = Date.now() + this.stopTimeoutMs;
    while (true) {
      const stillReady = await this.runtime.isReady();
      const stillListening = local ? await this.discover(local) : null;
      if (!stillReady && !stillListening && (!proc || (this.runtime.proc !== proc && closed(proc)))) break;
      if (Date.now() >= deadline) throw failure('RUNTIME_STOP_FAILED', 'Модель не освободила порт. Новый процесс не запущен.');
      await this.sleep(100);
    }
    for (const [taskId, entry] of this.manager.runtimes) {
      await entry.eventChain;
      if (!entry.pi.closed) {
        const state = await entry.pi.getState();
        if (state.isStreaming || state.isCompacting) throw failure('BUSY', 'Сессия Pi занята.');
        const task = this.manager.tasks?.get(taskId);
        if (state.sessionFile && task) {
          task.piSessionFile = state.sessionFile;
          await this.manager.store?.save(task);
        }
        entry.runtimeRestartClosing = true;
        await this.closePi(entry.pi);
        await entry.eventChain;
      }
      if (this.manager.runtimes.get(taskId) === entry) this.manager.runtimes.delete(taskId);
    }
    await this.runtime.ensureRunning(() => {}, profile.id);
    return this.runtime.getStatus();
  }
}
