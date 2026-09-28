import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { piAgentDir } from './pi-settings.mjs';

const MAX_DYNAMIC = 200;

async function existsDir(dir) {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function firstParagraph(markdown) {
  const lines = String(markdown || '').split(/\r?\n/).map((line) => line.trim());
  return lines.find((line) => line && !line.startsWith('#') && !line.startsWith('---')) || '';
}

function descriptionFromSkill(body) {
  const match = String(body || '').match(/<description>([\s\S]*?)<\/description>/i);
  if (match) return match[1].replace(/\s+/g, ' ').trim();
  return firstParagraph(body).replace(/\s+/g, ' ').trim();
}

function item(id, type, title, description, insertText) {
  return { id, type, title, description: description || '', insertText };
}

function actionFromLiveCommand(command) {
  const name = String(command?.name || '').trim();
  if (!name) return null;
  const source = String(command?.source || 'command');
  const type = source === 'skill' ? 'skill' : (source === 'prompt' ? 'prompt' : 'command');
  const title = name.startsWith('/') ? name : `/${name}`;
  return item(`${type}:${name}`, type, title, command?.description || '', title);
}

function actionsFromLiveCommands(commands) {
  if (!Array.isArray(commands)) return [];
  return commands.map(actionFromLiveCommand).filter(Boolean).slice(0, MAX_DYNAMIC);
}

async function readSkills(dir) {
  if (!await existsDir(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const skillFile = path.join(dir, name, 'SKILL.md');
    const body = await fs.readFile(skillFile, 'utf8').catch(() => '');
    result.push(item(`skill:${name}`, 'skill', `/skill:${name}`, descriptionFromSkill(body), `/skill:${name}`));
    if (result.length >= MAX_DYNAMIC) break;
  }
  return result;
}

async function readPrompts(dir) {
  if (!await existsDir(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && /\.(md|txt|prompt)$/i.test(entry.name))
    .slice(0, MAX_DYNAMIC)
    .map((entry) => {
      const name = entry.name.replace(/\.(md|txt|prompt)$/i, '');
      return item(`prompt:${name}`, 'prompt', `/prompt:${name}`, `Pi prompt: ${entry.name}`, `/prompt:${name}`);
    });
}

async function walkFiles(dir, result = []) {
  if (!await existsDir(dir) || result.length >= MAX_DYNAMIC) return result;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (result.length >= MAX_DYNAMIC) break;
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(full, result);
    else if (entry.isFile() && /\.(?:m?[jt]s|c?[jt]s)$/i.test(entry.name)) result.push(full);
  }
  return result;
}

function descriptionNearRegisterCommand(source, offset) {
  const chunk = source.slice(offset, offset + 1500);
  const match = chunk.match(/description\s*:\s*(['"`])([\s\S]*?)\1/);
  return match ? match[2].replace(/\s+/g, ' ').trim() : 'Команда расширения Pi.';
}

async function readRegisteredCommands(dir) {
  const files = await walkFiles(dir);
  const result = [];
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8').catch(() => '');
    for (const match of source.matchAll(/\.registerCommand\(\s*(['"`])([^'"`\s]+)\1/g)) {
      const name = match[2].trim();
      if (!name) continue;
      result.push(item(`command:${name}`, 'command', `/${name}`, descriptionNearRegisterCommand(source, match.index || 0), `/${name}`));
      if (result.length >= MAX_DYNAMIC) return result;
    }
  }
  return result;
}

function unique(items) {
  const seen = new Set();
  const result = [];
  for (const action of items) {
    if (seen.has(action.id)) continue;
    seen.add(action.id);
    result.push(action);
  }
  return result;
}

export async function listQuickActions({ rootDir = process.cwd(), env = process.env, liveCommands = [] } = {}) {
  const agentDir = piAgentDir(env);
  const home = os.homedir();
  const live = actionsFromLiveCommands(liveCommands);
  const dynamic = [
    ...live,
    ...await readSkills(path.join(agentDir, 'skills')),
    ...await readSkills(path.join(rootDir, '.pi', 'skills')),
    ...await readPrompts(path.join(agentDir, 'prompts')),
    ...await readPrompts(path.join(home, '.pi', 'prompts')),
    ...await readPrompts(path.join(rootDir, '.pi', 'prompts')),
    ...await readRegisteredCommands(path.join(agentDir, 'extensions')),
    ...await readRegisteredCommands(path.join(rootDir, '.pi', 'extensions')),
  ];
  const builtIn = [
    item('command:skill-template', 'command', '/skill:<name>', 'Вставить команду Pi для запуска skill по имени.', '/skill:'),
    item('command:prompt-template', 'command', '/prompt:<name>', 'Вставить команду Pi для запуска сохранённого prompt.', '/prompt:'),
    item('command:help', 'command', '/help', 'Показать справку Pi по slash-командам.', '/help'),
    item('command:clear', 'command', '/clear', 'Очистить/сбросить текущий контекст Pi, если команда поддерживается текущей версией Pi.', '/clear'),
    item('command:reload', 'command', '/reload', 'Перезагрузить расширения Pi, если команда поддерживается текущей версией Pi.', '/reload'),
  ];
  return unique([...dynamic, ...builtIn]).sort((a, b) => a.title.localeCompare(b.title));
}
