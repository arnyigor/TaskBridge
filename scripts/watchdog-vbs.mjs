#!/usr/bin/env node
// Renders the hidden watchdog VBS used by the "TaskBridge" scheduled task.
//
// The previous generated line was
//   sh.Run "cmd /c ""...\node.exe"" bin\taskbridge.mjs ensure >> ... 2>&1", 0, True
// and it never ran node at all: cmd /c strips the outer quotes, so the program
// path is split at its space and the redirection is never reached. The scheduled
// task still reported LastTaskResult 0 and no data/watchdog.log appeared, so a
// dead pair stayed dead until the operator started it by hand (2026-11-22).
//
// cmd /d /s /c with one outer pair around the whole command is the documented
// form for a quoted program path followed by quoted arguments and redirection.
// Kept in a module so tests can execute the exact rendered VBS.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function watchdogCommand({ root, node, log }) {
  const script = path.join(root, 'bin', 'taskbridge.mjs');
  return `cmd /d /s /c ""${node}" "${script}" ensure >> "${log}" 2>&1"`;
}

export function renderWatchdogVbs({ root, node, log }) {
  // VBScript doubles a quote to put one inside a string literal.
  const command = watchdogCommand({ root, node, log }).replaceAll('"', '""');
  return [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${root}"`,
    `sh.Run "${command}", 0, True`,
    '',
  ].join('\r\n');
}

function parseArgs(argv) {
  const value = flag => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : null;
  };
  const root = path.resolve(value('--root') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  return {
    root,
    node: path.resolve(value('--node') || process.execPath),
    log: path.resolve(value('--log') || path.join(root, 'data', 'watchdog.log')),
    out: value('--out'),
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { root, node, log, out } = parseArgs(process.argv.slice(2));
  const vbs = renderWatchdogVbs({ root, node, log });
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(path.resolve(out), vbs, 'ascii');
  } else {
    process.stdout.write(vbs);
  }
}
