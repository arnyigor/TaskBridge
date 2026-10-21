import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Pi stores its global settings in its agent dir (`~/.pi/agent/settings.json`
// unless overridden). One setting, images.blockImages, silently replaces every
// attached image with "Image reading is disabled." before it reaches any
// provider — the most common reason a vision model "cannot see" pictures.
// TaskBridge only reads these files to warn the user; it never edits them.
//
// The directory name is Pi's: `PI_CODING_AGENT_DIR` (docs/environment-variables.md
// of pi-coding-agent 1.3.0). TaskBridge used to look only at `PI_AGENT_DIR`,
// which Pi does not read at all — an operator who isolated Pi with the documented
// variable still got the default directory here (wrong settings file, wrong MCP
// cache, wrong image warning). `PI_AGENT_DIR` stays as a compatibility alias for
// older TaskBridge deployments that set it.
export function piAgentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR || env.PI_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
}

export function piSettingsPath(env = process.env) {
  return path.join(piAgentDir(env), 'settings.json');
}

export async function readPiSettings(env = process.env) {
  try {
    return JSON.parse(await fs.readFile(piSettingsPath(env), 'utf8'));
  } catch {
    return null;
  }
}

export function imagesBlocked(settings) {
  return settings?.images?.blockImages === true;
}
