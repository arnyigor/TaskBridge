// Actions on the machine that holds the files (the TaskBridge host), never in
// the browser: open a file with the application registered for its extension,
// reveal it in the file manager, or run it as a script. A browser cannot start a
// local application, so these run server-side and the routes that call them are
// restricted to requests from the machine itself.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';

const execute = promisify(execFile);
const fail = (code, message) => Object.assign(new Error(message), { code });

// The exact argv to run, per platform. Kept separate from execution so the
// mapping can be asserted without launching anything.
export function openCommand(target, { reveal = false, platform = process.platform } = {}) {
  if (platform === 'win32') {
    if (reveal) return { command: 'explorer.exe', args: [`/select,${target}`] };
    // Start-Process goes through ShellExecute, so the shell picks the program
    // registered for the file's extension (Notepad, Word, the image viewer, …).
    // The path travels through the environment to avoid any quoting/escaping.
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:TASKBRIDGE_OPEN_PATH'],
      env: { TASKBRIDGE_OPEN_PATH: target }
    };
  }
  if (platform === 'darwin') return { command: 'open', args: reveal ? ['-R', target] : [target] };
  // Linux and the BSDs have no portable "select this file in the file manager",
  // so revealing a file means opening the folder that contains it.
  return { command: 'xdg-open', args: [reveal ? path.dirname(target) : target] };
}

// Launch it. The OS entry points all return as soon as the application is
// started, so a short timeout only guards a hung launcher, not the app itself.
// `run` is injectable so tests assert the call without opening real windows.
export async function openLocalPath(target, { reveal = false, platform = process.platform, run = execute } = {}) {
  const plan = openCommand(target, { reveal, platform });
  try {
    await run(plan.command, plan.args, { windowsHide: true, timeout: 8000, maxBuffer: 64 * 1024, env: { ...process.env, ...(plan.env || {}) } });
  } catch (error) {
    // explorer.exe exits with 1 even when it did open the folder; treating that
    // as a failure told the operator «не удалось открыть» over an open window.
    if (plan.command === 'explorer.exe' && error.code === 1) return plan;
    throw fail('OPEN_FAILED', `Не удалось открыть «${path.basename(target)}» на компьютере: ${error.message}`);
  }
  return plan;
}

export const SCRIPT_TIMEOUT_MS = 30000;
export const SCRIPT_OUTPUT_BYTES = 64 * 1024;
// Captured before bounding: big enough that a normal command is captured whole,
// small enough that one runaway command cannot exhaust memory. The route trims
// what is sent to the browser and spills the rest to a file.
export const SHELL_MAX_BYTES = 8 * 1024 * 1024;

export const decodeConsoleBytes = (value, decoder) => value == null ? '' : (typeof value === 'string' ? value : decoder.decode(value));

// cmd and PowerShell write to a pipe in the console (OEM) code page — cp866 on
// Russian Windows — not UTF-8. Decoding those bytes as UTF-8 turns Cyrillic into
// mojibake (the PowerShell banner and error messages were the visible case).
// The code page is detected once and reused; an unsupported one falls back to
// UTF-8, which is still correct for the ASCII that dominates console output.
let cachedConsoleEncoding = null;
export async function consoleEncoding() {
  if (cachedConsoleEncoding) return cachedConsoleEncoding;
  let label = 'utf-8';
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execute('cmd.exe', ['/d', '/s', '/c', 'chcp'], { encoding: 'buffer', windowsHide: true, timeout: 3000 });
      const codePage = /(\d{3,5})/.exec(Buffer.from(stdout || '').toString('latin1'))?.[1];
      if (codePage && codePage !== '65001') label = `cp${codePage}`;
    } catch { /* no chcp: stay on utf-8 */ }
    try { new TextDecoder(label); } catch { label = 'utf-8'; }
  }
  cachedConsoleEncoding = label;
  return cachedConsoleEncoding;
}

// How to run a file as a script, by extension, per platform. Kept separate from
// execution so the mapping is testable without launching anything. An unknown
// extension returns null: guessing an interpreter would be worse than saying no.
export function scriptCommand(target, { platform = process.platform } = {}) {
  const ext = path.extname(target).toLowerCase();
  const win = platform === 'win32';
  const base = path.basename(target);
  const withTarget = command => ({ command, args: [target], label: base });
  switch (ext) {
    case '.bat': case '.cmd':
      return win ? { command: 'cmd.exe', args: ['/d', '/s', '/c', target], label: base } : null;
    case '.ps1':
      return win
        ? { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', target], label: base }
        : { command: 'pwsh', args: ['-NoProfile', '-File', target], label: base };
    case '.sh': case '.bash':
      return withTarget(win ? 'bash' : 'sh');
    case '.py': return withTarget(win ? 'py' : 'python3');
    // The very Node that runs TaskBridge, so a .js script needs nothing installed.
    // The very Node that runs TaskBridge, so a .js script needs nothing installed.
    // Node writes UTF-8 even on Windows, unlike the shell interpreters above.
    case '.js': case '.mjs': case '.cjs': return { ...withTarget(process.execPath), utf8: true };
    case '.rb': return withTarget('ruby');
    case '.pl': return withTarget('perl');
    default: return null;
  }
}

// The argv to run a command line. On Windows it is a batch file: cmd.exe
// executes only the FIRST line of a multi-line /c argument, so a pasted block
// like "cd …\npowershell …" would silently run just the cd. POSIX sh treats a
// newline as a separator, so it takes the whole block through -c. Kept separate
// so the mapping is testable without running anything.
export function shellCommand(command, { platform = process.platform, scriptPath = null } = {}) {
  return platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', scriptPath || command] }
    : { command: 'sh', args: ['-c', command] };
}

// Run a command line. Bounds and outcome handling mirror runLocalScript: a
// non-zero exit or a timeout is data, not an error; only a truly empty or
// oversized command, or a shell that will not start, is an error.
export async function runShellCommand(command, {
  cwd, platform = process.platform, timeoutMs = SCRIPT_TIMEOUT_MS, maxBytes = SHELL_MAX_BYTES,
  run = execute, writeFile = fs.writeFile, removeFile = fs.rm, tempDir = os.tmpdir(), makeId = () => crypto.randomUUID(),
  outputEncoding = null
} = {}) {
  const text = String(command || '').trim();
  if (!text) throw fail('INPUT_INVALID', 'Пустая команда.');
  // Generous: a pasted command can be a whole snippet. The body limit is the
  // real ceiling; this only rejects a runaway paste before it becomes a file.
  if (text.length > 65536) throw fail('INPUT_INVALID', 'Команда слишком длинная (максимум 65536 символов).');

  let scriptPath = null;
  let cleanup = null;
  if (platform === 'win32') {
    // `@echo off` so the batch's own lines are not echoed back. `chcp 65001`
    // makes cmd read this UTF-8 batch correctly (so a Cyrillic path or argument
    // survives) and makes cmd and PowerShell emit UTF-8 — otherwise a pipe gets
    // the OEM code page and Cyrillic comes back as mojibake. CRLF keeps cmd
    // happy on every Windows build.
    scriptPath = path.join(tempDir, `taskbridge-cmd-${makeId()}.cmd`);
    await writeFile(scriptPath, `@echo off\r\nchcp 65001 >nul\r\n${text}\r\n`, 'utf8');
    cleanup = () => removeFile(scriptPath, { force: true }).catch(() => {});
  }

  const decoder = new TextDecoder(outputEncoding || 'utf-8');
  const plan = shellCommand(text, { platform, scriptPath });
  const options = { cwd: cwd || process.cwd(), windowsHide: true, timeout: timeoutMs, maxBuffer: maxBytes, encoding: 'buffer', env: process.env };
  try {
    const { stdout, stderr } = await run(plan.command, plan.args, options);
    return { exitCode: 0, stdout: decodeConsoleBytes(stdout, decoder), stderr: decodeConsoleBytes(stderr, decoder), timedOut: false };
  } catch (error) {
    if (error.stdout === undefined && error.stderr === undefined) {
      throw fail('SHELL_RUN_FAILED', `Не удалось выполнить команду: ${error.message}`);
    }
    return {
      exitCode: typeof error.code === 'number' ? error.code : null,
      stdout: decodeConsoleBytes(error.stdout, decoder),
      stderr: decodeConsoleBytes(error.stderr, decoder),
      timedOut: error.killed === true || error.signal === 'SIGTERM'
    };
  } finally {
    if (cleanup) await cleanup();
  }
}

// Run it and collect the result. A non-zero exit code and a timeout are normal
// outcomes of a script, so they come back as data; only a failure to even start
// it (unknown extension, missing interpreter) is an error. `run` is injectable.
export async function runLocalScript(target, { platform = process.platform, timeoutMs = SCRIPT_TIMEOUT_MS, maxBytes = SCRIPT_OUTPUT_BYTES, run = execute, outputEncoding = null } = {}) {
  const plan = scriptCommand(target, { platform });
  if (!plan) throw fail('SCRIPT_NOT_RUNNABLE', `«${path.basename(target)}» не похож на скрипт с известным интерпретатором.`);
  const decoder = new TextDecoder(outputEncoding || (platform === 'win32' && !plan.utf8 ? await consoleEncoding() : 'utf-8'));
  const options = { cwd: path.dirname(target), windowsHide: true, timeout: timeoutMs, maxBuffer: maxBytes, encoding: 'buffer', env: process.env };
  try {
    const { stdout, stderr } = await run(plan.command, plan.args, options);
    return { command: plan.label, exitCode: 0, stdout: decodeConsoleBytes(stdout, decoder), stderr: decodeConsoleBytes(stderr, decoder), timedOut: false };
  } catch (error) {
    // execFile rejects on a non-zero exit too; that is the script's result, not a
    // server fault. Anything without stdout/stderr is a real launch failure.
    if (error.stdout === undefined && error.stderr === undefined) {
      throw fail('SCRIPT_RUN_FAILED', `Не удалось запустить «${path.basename(target)}»: ${error.message}`);
    }
    return {
      command: plan.label,
      exitCode: typeof error.code === 'number' ? error.code : null,
      stdout: decodeConsoleBytes(error.stdout, decoder),
      stderr: decodeConsoleBytes(error.stderr, decoder),
      timedOut: error.killed === true || error.signal === 'SIGTERM'
    };
  }
}
