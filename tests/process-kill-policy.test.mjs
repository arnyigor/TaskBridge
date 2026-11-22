import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Invariant from the 2026-11-22 incident: stopping TaskBridge may only act on
// exact, identified PIDs. Image-name kills destroy unrelated Node applications
// and every Pi session at once. This static gate catches a future script that
// reintroduces one, including in the clients.
const root = fileURLToPath(new URL('..', import.meta.url));
const SCAN = [
  { dir: 'src', extensions: ['.mjs', '.js'] },
  { dir: 'scripts', extensions: ['.mjs', '.js', '.ps1', '.cmd', '.bat'] },
  { dir: 'bin', extensions: ['.mjs', '.js'] },
  { dir: 'tests', extensions: ['.mjs', '.js'] },
  { dir: 'clients/kmp', extensions: ['.kt', '.kts'] },
];
const SKIP_DIRS = new Set(['node_modules', '.local', 'build', '.gradle', 'dist', '.git']);
const SELF = 'process-kill-policy.test.mjs';
const PATTERNS = [
  { name: 'taskkill /IM (image-name kill)', re: /\btaskkill\b[^\r\n]*\/IM\b/i },
  { name: 'pkill node', re: /\bpkill\b[^\r\n]*\bnode\b/i },
  { name: 'killall node', re: /\bkillall\b[^\r\n]*\bnode\b/i },
  { name: 'Stop-Process -Name node', re: /\bStop-Process\b[^\r\n]*-Name\s+['"]?node/i },
];

function files(dir, extensions) {
  const found = [];
  const walk = current => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(current, entry.name));
      } else if (entry.isFile() && extensions.includes(path.extname(entry.name))) {
        found.push(path.join(current, entry.name));
      }
    }
  };
  walk(dir);
  return found;
}

const isComment = line => /^\s*(\/\/|#|rem\b|\*|<!--|--)/i.test(line);

test('no executable file kills processes by image name', () => {
  const offenders = [];
  for (const { dir, extensions } of SCAN) {
    for (const file of files(path.join(root, dir), extensions)) {
      if (path.basename(file) === SELF) continue;
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (isComment(line)) return;
        for (const pattern of PATTERNS) {
          if (pattern.re.test(line)) offenders.push(`${path.relative(root, file)}:${index + 1} ${pattern.name}: ${line.trim()}`);
        }
      });
    }
  }
  assert.deepEqual(offenders, [], `broad process kills are forbidden:\n${offenders.join('\n')}`);
});
