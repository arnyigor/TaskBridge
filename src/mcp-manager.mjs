import fs from 'node:fs/promises';
import path from 'node:path';
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

export function normalizeServer(name, entry) {
  const value = entry && typeof entry === 'object' ? entry : {};
  const url = typeof value.url === 'string' && value.url ? value.url : null;
  const command = typeof value.command === 'string' && value.command ? value.command : null;
  return {
    name,
    url,
    command,
    transport: url ? 'http' : command ? 'stdio' : null,
    disabled: value.disabled === true
  };
}

export function isMcpConfig(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class McpManager {
  constructor(piConfig = {}, dataRoot) {
    this.piConfig = piConfig || {};
    this.dataRoot = dataRoot;
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
      return isMcpConfig(parsed) ? parsed : { ...EMPTY_CONFIG };
    } catch {
      return { ...EMPTY_CONFIG };
    }
  }

  async write(config) {
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    await fs.writeFile(this.path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
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
    return normalizeServer(name, entry);
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
      catch { await this.importFromPi(env).catch(() => this.write({ ...EMPTY_CONFIG })); }
    }
  }

  // Args/env appended to every Pi launch so MCP is scoped by TaskBridge.
  launch() {
    if (this.mode === 'inherit') return { args: [], env: {} };
    const file = this.mode === 'off' ? this.offPath : this.path;
    return { args: ['--mcp-config', file], env: { PI_MCP_CONFIG_MODE: 'exclusive' } };
  }

  async status() {
    const mode = this.mode;
    const servers = mode === 'inherit' ? await this.piServers() : await this.servers();
    let exists = false;
    try { await fs.access(mode === 'off' ? this.offPath : this.path); exists = true; } catch { /* not created yet */ }
    return {
      mode,
      configPath: this.path,
      offPath: this.offPath,
      activePath: mode === 'off' ? this.offPath : mode === 'managed' ? this.path : null,
      exists,
      servers
    };
  }
}
