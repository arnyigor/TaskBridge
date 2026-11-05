import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isPrivatePath } from '../files.mjs';

const invalid = () => Object.assign(new Error('Недопустимые настройки внешнего чтения.'), { code: 'INPUT_INVALID' });
const forbidden = () => Object.assign(new Error('Внешний каталог недоступен.'), { code: 'FILE_FORBIDDEN' });
const DEFAULT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.txt', '.md', '.json'];
const EXTENSIONS = new Set(DEFAULT_EXTENSIONS);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function checkRootPolicy(target) {
  const home = os.homedir();
  // No disk root, whole user profile (or its ancestors), secrets or OS trees.
  if (target === path.parse(target).root || within(target, home) || isPrivatePath(target)) throw forbidden();
  const parts = target.replaceAll('\\', '/').split('/');
  if (parts.some(part => /^(?:windows|program files(?: \(x86\))?|programdata|appdata|\$recycle\.bin|system volume information)$/i.test(part))) throw forbidden();
  if (process.platform === 'win32') {
    for (const name of ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'APPDATA', 'LOCALAPPDATA']) {
      const value = process.env[name];
      if (value && path.isAbsolute(value) && within(path.resolve(value), target)) throw forbidden();
    }
  }
}

async function canonicalRoot(value, allowMissing = false) {
  // Local, ordinary absolute paths only. Do not accept UNC/device namespaces,
  // ADS, DOS device names or ambiguous Windows trailing-dot/space aliases.
  if (typeof value !== 'string' || !path.isAbsolute(value) || /^(?:\\\\|\/\/)/.test(value) || /[\x00-\x1f<>"|?*]/.test(value)) throw invalid();
  const withoutDrive = value.replace(/^[A-Za-z]:[\\/]/, '');
  if (withoutDrive.includes(':') || withoutDrive.split(/[\\/]/).some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw invalid();
  const absolute = path.resolve(value);
  checkRootPolicy(absolute);
  let resolved;
  try {
    resolved = await fs.realpath(absolute);
    if (!(await fs.stat(resolved)).isDirectory()) throw invalid();
  } catch (error) {
    if (error.code === 'INPUT_INVALID') throw error;
    if (allowMissing && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return absolute;
    // Never put server paths from an fs error into a public response.
    throw Object.assign(new Error('Внешний каталог не найден или недоступен.'), { code: 'NOT_FOUND' });
  }
  // Saved roots must not silently follow a junction substituted while offline.
  // Keep their spelling at startup; the handle-based reader will fail closed.
  if (allowMissing && resolved.toLowerCase() !== absolute.toLowerCase()) return absolute;
  checkRootPolicy(resolved);
  return resolved;
}

export function externalProjectIdentity(project) {
  if (!project) return null;
  const target = path.resolve(project.path || '');
  return project.registrationId || `legacy:${crypto.createHash('sha256').update(process.platform === 'win32' ? target.toLowerCase() : target).digest('hex')}`;
}

export function externalReadRevision(project) {
  const revision = project.externalReadRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) throw invalid();
  return revision;
}

/** Validation only; never grants missing permissions or mutates the input. */
export async function normalizeExternalReadProject(project, { allowMissing = false } = {}) {
  externalReadRevision(project);
  if (project.externalReadDirectories === undefined) return project;
  const directories = project.externalReadDirectories;
  if (!Array.isArray(directories) || directories.length > 32) throw invalid();
  const ids = new Set();
  const roots = [];
  for (const root of directories) {
    if (!root || !ID.test(root.id ?? '') || typeof root.id !== 'string' || ids.has(root.id)) throw invalid();
    ids.add(root.id);
    if (root.enabled !== undefined && typeof root.enabled !== 'boolean') throw invalid();
    for (const flag of ['canBrowse', 'canPreview', 'canAttach', 'agentCanRead', 'allowModelTransfer', 'revoked']) {
      if (root[flag] !== undefined && typeof root[flag] !== 'boolean') throw invalid();
    }
    const extensions = root.extensions ?? DEFAULT_EXTENSIONS;
    if (!Array.isArray(extensions) || !extensions.length || extensions.some(ext => typeof ext !== 'string' || !EXTENSIONS.has(ext))) throw invalid();
    roots.push({
      id: root.id,
      path: await canonicalRoot(root.path, allowMissing),
      enabled: root.enabled === true && root.revoked !== true,
      revoked: root.revoked === true,
      extensions: [...new Set(extensions)],
      canBrowse: root.canBrowse === true,
      canPreview: root.canPreview === true,
      canAttach: root.canAttach === true,
      agentCanRead: root.agentCanRead !== false,
      allowModelTransfer: root.allowModelTransfer === true,
    });
  }
  return { ...project, externalReadDirectories: roots };
}

/** A project-scoped lookup, not a file resolver. File reads need EXT-02 checks. */
export function resolveExternalRoot(project, rootId) {
  const roots = project?.externalReadDirectories;
  const root = Array.isArray(roots) && roots.find(item => item.id === rootId && item.enabled === true && item.agentCanRead !== false);
  if (!root) throw forbidden();
  return root;
}

/** Local management building block; caller must authorize and persist atomically. */
export async function reviseExternalReadProject(project, directories, expectedRevision) {
  const revision = externalReadRevision(project);
  if (expectedRevision !== revision) throw Object.assign(new Error('Настройки внешнего чтения изменились.'), { code: 'REVISION_CONFLICT' });
  const normalized = await normalizeExternalReadProject({ ...project, externalReadDirectories: directories });
  if (JSON.stringify(normalized.externalReadDirectories) === JSON.stringify(project.externalReadDirectories)) return project;
  if (revision === Number.MAX_SAFE_INTEGER) throw invalid();
  return { ...normalized, externalReadRevision: revision + 1 };
}
