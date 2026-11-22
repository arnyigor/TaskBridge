import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { piAgentDir } from './pi-settings.mjs';

// MCP for Pi is configured by the `pi-mcp-adapter` extension. TaskBridge does
// not edit Pi's own ~/.pi/agent/mcp.json; instead it keeps its own config file
// and launches Pi with `--mcp-config <file>` + `PI_MCP_CONFIG_MODE=exclusive`,
// which makes that file the *only* MCP source for the task. Modes:
//   inherit  — leave Pi's own configuration untouched (previous behaviour)
//   managed  — TaskBridge-owned file, servers toggled from the UI
//   off      — an empty config, i.e. no MCP tools at all
export const MCP_MODES = ['inherit', 'managed', 'off'];

const EMPTY_CONFIG = { mcpServers: {} };

// Pinned into every TaskBridge-owned config, and applied last in write() so an
// imported `settings.warnOnLargeDirectTools: true` cannot re-enable it.
//
// Why: at 75+ resolved direct tools the adapter prints one ~290-character line
// with plain `console.warn` (pi-mcp-adapter, direct-tool-surface.ts). A raw
// write to stdout bypasses any renderer that owns the terminal, so in an
// interactive Pi TUI the line wraps over several rows on top of the frame and
// the prompt box is redrawn over/under it (the "input layout breaks" symptom),
// and in `--mode rpc` the same line arrives as a non-JSON frame and is logged
// as PI_PROTOCOL_ERROR for a task that is otherwise fine. TaskBridge is the
// owner of this file, so the advisory is switched off here; the durable fix on
// the Pi side is fewer direct tools (5-20 per the adapter README) — see
// docs/mcp-adapter-ui-glitch-2026-09-18.md. Pi's own ~/.pi/agent/mcp.json is
// never touched, so an interactive session is unaffected by this pin.
const PINNED_SETTINGS = { warnOnLargeDirectTools: false };

// Pi 1.5's `--mcp-config` parser only accepts the standard MCP fields. The
// adapter-owned keys stay in TaskBridge's shared config (and in the UI), but a
// single unknown key makes Pi reject the whole file and report every server as
// «must configure exactly one of command, url, or socket».
const PI_ENTRY_FIELDS = ['command', 'args', 'env', 'cwd', 'url', 'headers'];
function forPiLauncher(entry) {
  const out = {};
  for (const key of PI_ENTRY_FIELDS) if (entry && entry[key] !== undefined) out[key] = entry[key];
  return out;
}

function withPinnedSettings(config) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const settings = isMcpConfig(source.settings) ? { ...source.settings } : {};
  return { ...source, settings: { ...settings, ...PINNED_SETTINGS } };
}

// A real initialize + tools/list over stdio. A path that exists is not a working
// MCP: the server can still miss a dependency, crash before handshake, or hang.
export function probeMcpHandshake(entry, { timeoutMs = 5000 } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    let child;
    try {
      child = spawn(entry.command, entry.args || [], {
        cwd: entry.cwd || undefined,
        env: { ...process.env, ...(entry.env || {}) },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, error: error.message, latencyMs: Date.now() - started });
      return;
    }
    let stdout = '';
    let stderr = '';
    let stage = 'initialize';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve({ ...result, latencyMs: Date.now() - started, stderr: stderr.trim().slice(-1500) });
    };
    const timer = setTimeout(() => finish({ ok: false, error: `timeout after ${timeoutMs} ms` }), timeoutMs);
    const send = message => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch (error) { finish({ ok: false, error: error.message }); }
    };
    child.stdout.on('data', chunk => {
      stdout += chunk;
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim().startsWith('{')) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && stage === 'initialize') {
          if (message.error) { finish({ ok: false, error: JSON.stringify(message.error) }); return; }
          stage = 'tools';
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2) {
          if (message.error) { finish({ ok: false, error: JSON.stringify(message.error) }); return; }
          const tools = Array.isArray(message.result?.tools) ? message.result.tools : [];
          finish({ ok: true, toolCount: tools.length, tools: tools.map(tool => tool.name).filter(Boolean) });
        }
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => finish({ ok: false, error: error.message }));
    child.on('exit', code => finish({ ok: false, error: `exited before handshake (code ${code})` }));
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'taskbridge', version: '1' } },
    });
  });
}

export function normalizeServer(name, entry) {
  const value = entry && typeof entry === 'object' ? entry : {};
  const url = typeof value.url === 'string' && value.url ? value.url : null;
  const command = typeof value.command === 'string' && value.command ? value.command : null;
  return {
    name,
    url,
    command,
    args: Array.isArray(value.args) ? value.args.filter(arg => typeof arg === 'string') : [],
    transport: url ? 'http' : command ? 'stdio' : null,
    disabled: value.disabled === true || value.enabled === false,
    excludeTools: Array.isArray(value.excludeTools) ? value.excludeTools.filter(t => typeof t === 'string') : [],
    auth: value.oauth ? 'oauth' : value.headers?.Authorization || value.headers?.authorization ? 'configured' : 'none',
    scopes: Array.isArray(value.oauth?.scopes) ? value.oauth.scopes.filter(scope => typeof scope === 'string') : []
  };
}

// Pi's MCP adapter caches every server's tool list in ~/.pi/agent/mcp-cache.json.
// Reading it lets TaskBridge show per-tool toggles without connecting to a server.
async function readToolCache(env = process.env) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(piAgentDir(env), 'mcp-cache.json'), 'utf8'));
    const servers = isMcpConfig(parsed?.servers) ? parsed.servers : {};
    const out = {};
    for (const [name, entry] of Object.entries(servers)) {
      const tools = Array.isArray(entry?.tools) ? entry.tools : [];
      out[name] = tools
        .filter(tool => tool && typeof tool.name === 'string')
        .map(tool => ({ name: tool.name, description: typeof tool.description === 'string' ? tool.description : '' }));
    }
    return out;
  } catch {
    return {};
  }
}

// Order-insensitive digest of the server map exactly as Pi receives it.
function fingerprintOf(servers) {
  const keys = Object.keys(servers || {}).sort();
  const canonical = JSON.stringify(keys.map(key => [key, servers[key]]));
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function isMcpConfig(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class McpManager {
  constructor(piConfig = {}, dataRoot) {
    this.piConfig = piConfig || {};
    this.dataRoot = dataRoot;
    this.health = new Map();
  }

  get settings() {
    return this.piConfig.mcp || {};
  }

  get mode() {
    const mode = this.settings.mode;
    return MCP_MODES.includes(mode) ? mode : 'inherit';
  }

  get path() {
    const configured = this.settings.configPath;
    if (configured) return path.isAbsolute(configured) ? configured : path.join(this.dataRoot, configured);
    return path.join(this.dataRoot, 'mcp.json');
  }

  get offPath() {
    return path.join(this.dataRoot, 'mcp.off.json');
  }

  async read() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.path, 'utf8'));
      return isMcpConfig(parsed) ? parsed : { mcpServers: {} };
    } catch {
      return { mcpServers: {} };
    }
  }

  async write(config) {
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    await fs.writeFile(this.path, `${JSON.stringify(withPinnedSettings(config), null, 2)}\n`, 'utf8');
  }

  async #audit(action, target, details = {}) {
    const entry = JSON.stringify({ at: new Date().toISOString(), action, target, ...details });
    await fs.mkdir(this.dataRoot, { recursive: true });
    await fs.appendFile(path.join(this.dataRoot, 'mcp-audit.jsonl'), `${entry}\n`, 'utf8').catch(() => {});
  }

  async servers() {
    const config = await this.read();
    const map = isMcpConfig(config.mcpServers) ? config.mcpServers : {};
    return Object.entries(map).map(([name, entry]) => normalizeServer(name, entry)).sort((a, b) => a.name.localeCompare(b.name));
  }

  // Server list from Pi's own config, shown read-only in `inherit` mode.
  async piServers(env = process.env) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(piAgentDir(env), 'mcp.json'), 'utf8'));
      const map = isMcpConfig(parsed?.mcpServers) ? parsed.mcpServers : {};
      return Object.entries(map).map(([name, entry]) => normalizeServer(name, entry)).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  async setDisabled(name, disabled) {
    const config = await this.read();
    const map = isMcpConfig(config.mcpServers) ? config.mcpServers : {};
    const entry = map[name];
    if (!isMcpConfig(entry)) throw Object.assign(new Error(`MCP-сервер не найден: ${name}`), { code: 'NOT_FOUND' });
    if (disabled) entry.disabled = true;
    else delete entry.disabled;
    config.mcpServers = map;
    await this.write(config);
    await this.#audit('server.toggle', name, { enabled: !disabled });
    return normalizeServer(name, entry);
  }

  // Per-tool toggle: the adapter supports excludeTools on a server entry.
  async setToolExcluded(name, tool, excluded) {
    if (typeof tool !== 'string' || !tool.trim()) throw Object.assign(new Error('Не указан MCP-инструмент.'), { code: 'INPUT_INVALID' });
    const config = await this.read();
    const map = isMcpConfig(config.mcpServers) ? config.mcpServers : {};
    const entry = map[name];
    if (!isMcpConfig(entry)) throw Object.assign(new Error(`MCP-сервер не найден: ${name}`), { code: 'NOT_FOUND' });
    const set = new Set(Array.isArray(entry.excludeTools) ? entry.excludeTools.filter(t => typeof t === 'string') : []);
    if (excluded) set.add(tool);
    else set.delete(tool);
    if (set.size) entry.excludeTools = [...set];
    else delete entry.excludeTools;
    config.mcpServers = map;
    await this.write(config);
    await this.#audit('tool.toggle', `${name}/${tool}`, { enabled: !excluded });
    return normalizeServer(name, entry);
  }

  async upsertServer(name, definition) {
    if (typeof name !== 'string' || !name.trim() || !/^[A-Za-z0-9._-]+$/.test(name)) {
      throw Object.assign(new Error('Имя MCP-сервера может содержать буквы, цифры, точку, дефис и подчёркивание.'), { code: 'INPUT_INVALID' });
    }
    const url = typeof definition?.url === 'string' ? definition.url.trim() : '';
    const command = typeof definition?.command === 'string' ? definition.command.trim() : '';
    if (Boolean(url) === Boolean(command)) throw Object.assign(new Error('Укажите ровно один transport: URL или command.'), { code: 'INPUT_INVALID' });
    if (url) {
      let parsed;
      try { parsed = new URL(url); } catch { throw Object.assign(new Error('Некорректный URL MCP-сервера.'), { code: 'INPUT_INVALID' }); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw Object.assign(new Error('MCP URL должен использовать HTTP или HTTPS.'), { code: 'INPUT_INVALID' });
    }
    const config = await this.read();
    const map = isMcpConfig(config.mcpServers) ? config.mcpServers : {};
    const previous = isMcpConfig(map[name]) ? map[name] : {};
    map[name] = {
      ...previous,
      ...(url ? { url } : { command, args: Array.isArray(definition.args) ? definition.args.filter(arg => typeof arg === 'string') : [] })
    };
    if (url) { delete map[name].command; delete map[name].args; }
    else delete map[name].url;
    config.mcpServers = map;
    await this.write(config);
    await this.#audit(previous.url || previous.command ? 'server.update' : 'server.create', name, { transport: url ? 'http' : 'stdio' });
    return normalizeServer(name, map[name]);
  }

  async removeServer(name) {
    const config = await this.read();
    const map = isMcpConfig(config.mcpServers) ? config.mcpServers : {};
    if (!isMcpConfig(map[name])) throw Object.assign(new Error(`MCP-сервер не найден: ${name}`), { code: 'NOT_FOUND' });
    delete map[name];
    config.mcpServers = map;
    await this.write(config);
    this.health.delete(name);
    await this.#audit('server.remove', name);
  }

  async probe(name = null, { timeoutMs = 5000 } = {}) {
    const servers = (this.mode === 'inherit' ? await this.piServers() : await this.servers()).filter(server => !name || server.name === name);
    if (name && servers.length === 0) throw Object.assign(new Error(`MCP-сервер не найден: ${name}`), { code: 'NOT_FOUND' });
    const rawConfig = this.mode === 'inherit' ? {} : await this.read();
    const rawServers = isMcpConfig(rawConfig.mcpServers) ? rawConfig.mcpServers : {};
    await Promise.all(servers.map(async server => {
      const started = Date.now();
      let result;
      if (server.disabled) result = { state: 'disabled', latencyMs: null, checkedAt: new Date().toISOString() };
      else if (server.url) {
        try {
          const response = await fetch(server.url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
          result = { state: response.status < 500 ? 'reachable' : 'error', latencyMs: Date.now() - started, checkedAt: new Date().toISOString(), statusCode: response.status, error: response.status < 500 ? null : `HTTP ${response.status}` };
        } catch (error) {
          result = { state: 'error', latencyMs: Date.now() - started, checkedAt: new Date().toISOString(), error: error.message };
        }
      } else if (server.command) {
        const entry = isMcpConfig(rawServers[server.name]) ? rawServers[server.name] : { command: server.command, args: server.args };
        const handshake = await probeMcpHandshake(entry, { timeoutMs });
        result = handshake.ok
          ? { state: 'ready', latencyMs: Date.now() - started, checkedAt: new Date().toISOString(), toolCount: handshake.toolCount }
          : { state: 'error', latencyMs: Date.now() - started, checkedAt: new Date().toISOString(), error: handshake.error };
      } else result = { state: 'error', latencyMs: Date.now() - started, checkedAt: new Date().toISOString(), error: 'Не задана команда или URL' };
      this.health.set(server.name, result);
    }));
    return this.status();
  }

  // Copies Pi's global MCP config into the TaskBridge-owned file.
  async importFromPi(env = process.env) {
    const source = path.join(piAgentDir(env), 'mcp.json');
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(source, 'utf8'));
    } catch (error) {
      throw Object.assign(new Error(`Не удалось прочитать ${source}: ${error.message}`), { code: 'NOT_FOUND' });
    }
    const config = { mcpServers: isMcpConfig(parsed.mcpServers) ? parsed.mcpServers : {} };
    if (isMcpConfig(parsed.settings)) config.settings = parsed.settings;
    await this.write(config);
    await this.#audit('config.import', 'pi', { servers: Object.keys(config.mcpServers).length });
    return this.servers();
  }

  async ensureReady(env = process.env) {
    if (this.mode === 'off') {
      try { await fs.access(this.offPath); }
      catch {
        await fs.mkdir(path.dirname(this.offPath), { recursive: true });
        await fs.writeFile(this.offPath, `${JSON.stringify(EMPTY_CONFIG, null, 2)}\n`, 'utf8');
      }
      return;
    }
    if (this.mode === 'managed') {
      try { await fs.access(this.path); }
      catch { await this.importFromPi(env).catch(() => this.write({ mcpServers: {} })); }
    }
  }

  // Args/env appended to every Pi launch so MCP is scoped by TaskBridge.
  launch() {
    if (this.mode === 'inherit') return { args: [], env: {} };
    const file = this.mode === 'off' ? this.offPath : this.path;
    return { args: ['--mcp-config', file], env: { PI_MCP_CONFIG_MODE: 'exclusive' } };
  }

  // The configuration a Pi process is actually launched with, for one task.
  //
  // One source of truth for three things that used to diverge: the args/env Pi
  // gets, the per-task override, and the fingerprint the API reports so the UI
  // can say whether a change reached an already running session.
  //
  // Modes (per task `mcp.mode` wins over the global one):
  //   inherit — Pi's own config; TaskBridge cannot scope it, so a per-task
  //             `disabledServers` list cannot be applied and `scope` says so
  //             instead of silently dropping it (CMP-01 defect: the declared
  //             per-task mode was parsed and then never used).
  //   managed — TaskBridge file, per-task `disabledServers` → derived copy.
  //   off     — empty file; a per-task list is meaningless, nothing to disable.
  async launchFor(taskMcp = null, { taskDir = null, write = true } = {}) {
    const requested = MCP_MODES.includes(taskMcp?.mode) ? taskMcp.mode : this.mode;
    if (requested === 'inherit') {
      return { mode: 'inherit', scope: 'pi', args: [], env: {}, path: null, fingerprint: 'inherit', ignored: taskMcp?.disabledServers?.length ? 'inherit' : null };
    }
    const basePath = requested === 'off' ? this.offPath : this.path;
    const env = { PI_MCP_CONFIG_MODE: 'exclusive' };
    if (requested === 'off') {
      // The off config is empty by construction: a task cannot enable anything
      // from it, so its `disabledServers` list has no effect (reported, not lost).
      return {
        mode: 'off', scope: 'global', args: ['--mcp-config', basePath], env, path: basePath,
        fingerprint: 'off', ignored: taskMcp?.disabledServers?.length ? 'off' : null
      };
    }
    const config = await this.read();
    const servers = isMcpConfig(config.mcpServers) ? { ...config.mcpServers } : {};
    const disabledServers = Array.isArray(taskMcp?.disabledServers) ? taskMcp.disabledServers.filter(name => typeof name === 'string') : [];
    // Pi 1.5 rejects the whole `--mcp-config` when any entry carries the
    // TaskBridge-only `disabled` marker; it then reports every server as
    // «must configure exactly one of command, url, or socket». Disabled
    // servers therefore do not belong in the file Pi reads at all.
    const active = Object.fromEntries(Object.entries(servers)
      .filter(([name, entry]) => entry?.disabled !== true && entry?.enabled !== false && !disabledServers.includes(name))
      .map(([name, entry]) => [name, forPiLauncher(entry)]));
    const file = taskDir ? path.join(taskDir, 'mcp.json') : path.join(path.dirname(this.path), 'mcp-active.json');
    const scope = taskDir ? 'task' : 'global';
    // `write: false` is for comparisons only (has this change reached a running
    // process?): a status read must not touch the filesystem.
    if (write) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `${JSON.stringify(withPinnedSettings({ ...config, mcpServers: active }), null, 2)}\n`, 'utf8');
    }
    return {
      mode: 'managed', scope, args: ['--mcp-config', file], env, path: file,
      fingerprint: fingerprintOf(active), ignored: null
    };
  }

  // Fingerprint of the configuration currently served to new sessions. A live
  // Pi process keeps the config it was started with (args/env are fixed at
  // spawn), so comparing this with a process snapshot is the only honest way to
  // answer «дошло ли изменение до этой сессии».
  async activeFingerprint() {
    if (this.mode === 'inherit') return 'inherit';
    if (this.mode === 'off') return 'off';
    const config = await this.read();
    const servers = isMcpConfig(config.mcpServers) ? config.mcpServers : {};
    return fingerprintOf(Object.fromEntries(Object.entries(servers)
      .filter(([, entry]) => entry?.disabled !== true && entry?.enabled !== false)
      .map(([name, entry]) => [name, forPiLauncher(entry)])));
  }

  async status(env = process.env) {
    const mode = this.mode;
    const tools = await readToolCache(env);
    const rawServers = mode === 'inherit' ? await this.piServers(env) : await this.servers();
    const owners = new Map();
    for (const server of rawServers) for (const tool of tools[server.name] || []) owners.set(tool.name, [...(owners.get(tool.name) || []), server.name]);
    const collisions = [...owners.entries()].filter(([, names]) => names.length > 1).map(([tool, servers]) => ({ tool, servers }));
    const servers = rawServers.map(server => {
      // `excludeTools` was written and displayed but never applied to the tool
      // list this report counts (CMP-01): an excluded tool was still billed as
      // context. `enabled` is what the model may actually receive; `cached`
      // stays visible so a toggle is not mistaken for «the tool is gone».
      const excluded = new Set(server.excludeTools || []);
      const cached = tools[server.name] || [];
      return {
        ...server,
        tools: cached.map(tool => ({ ...tool, enabled: !server.disabled && !excluded.has(tool.name) })),
        health: this.health.get(server.name) || null,
      };
    });
    let exists = false;
    try { await fs.access(mode === 'off' ? this.offPath : this.path); exists = true; } catch { /* not created yet */ }
    return {
      mode,
      configPath: this.path,
      offPath: this.offPath,
      activePath: mode === 'off' ? this.offPath : mode === 'managed' ? this.path : null,
      // `inherit` reads Pi's own file: the toggles in TaskBridge do not reach it.
      controllable: mode !== 'inherit',
      fingerprint: await this.activeFingerprint(),
      exists,
      servers,
      collisions
    };
  }
}
