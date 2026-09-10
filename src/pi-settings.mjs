import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Pi stores its global settings in ~/.pi/agent/settings.json. One of them,
// images.blockImages, silently replaces every attached image with
// "Image reading is disabled." before it reaches any provider — the most common
// reason a vision model "cannot see" pictures. TaskBridge only reads it to warn
// the user; it never edits Pi's settings.
export function piAgentDir(env = process.env) {
  return env.PI_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
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
