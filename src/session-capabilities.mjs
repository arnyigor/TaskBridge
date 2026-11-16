import fs from 'node:fs/promises';
import path from 'node:path';

export function sessionMode(value) {
  if (value == null) return 'agent';
  if (!['agent', 'plan', 'chat'].includes(value)) throw Object.assign(new Error('Unsupported session mode'), { code: 'INPUT_INVALID' });
  return value;
}

export function readOnlySession(task) {
  return task?.mode === 'plan' || task?.mode === 'chat';
}

export async function confinedPath(root, name = '.') {
  const base = await fs.realpath(root);
  const target = await fs.realpath(path.resolve(base, name));
  const relative = path.relative(base, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path outside project');
  return target;
}

export async function planRead(root, name = '.') {
  const target = await confinedPath(root, name);
  const stat = await fs.stat(target);
  if (stat.isDirectory()) return (await fs.readdir(target)).slice(0, 500).join('\n');
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Not a regular text file or file too large');
  const data = await fs.readFile(target);
  if (data.includes(0)) throw new Error('Binary file');
  return data.toString('utf8');
}

export async function planSearch(root, query, name = '.') {
  if (!query || query.length > 500) throw new Error('Invalid literal search');
  const hits = [];
  let visited = 0;
  async function walk(name) {
    if (++visited > 5000 || hits.length >= 100) return;
    const target = await confinedPath(root, name);
    const stat = await fs.lstat(target);
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(target, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || ['.git', 'node_modules', '.gradle', 'build'].includes(entry.name)) continue;
        await walk(path.join(name, entry.name));
      }
    } else if (stat.isFile() && stat.size <= 1024 * 1024) {
      const text = await planRead(root, name).catch(() => '');
      for (const [i, line] of text.split('\n').entries()) {
        if (hits.length >= 100) break;
        if (line.includes(query)) hits.push(`${name}:${i + 1}: ${line.slice(0, 500)}`);
      }
    }
  }
  await walk(name);
  return hits.join('\n');
}
