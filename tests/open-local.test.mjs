import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openCommand, openLocalPath, scriptCommand, runLocalScript, shellCommand, runShellCommand } from '../src/open-local.mjs';

test('openCommand maps open/reveal to the right program on each platform', () => {
  const win = openCommand('C:\\work\\out.csv', { platform: 'win32' });
  assert.equal(win.command, 'powershell.exe');
  assert.match(win.args.join(' '), /Start-Process/, 'goes through ShellExecute so the extension is honoured');
  assert.equal(win.env.TASKBRIDGE_OPEN_PATH, 'C:\\work\\out.csv', 'the path travels by env, never by argv');
  assert.equal(win.args.some(arg => arg.includes('out.csv')), false, 'and never appears in the command line');

  const winReveal = openCommand('C:\\work\\out.csv', { platform: 'win32', reveal: true });
  assert.equal(winReveal.command, 'explorer.exe');
  assert.deepEqual(winReveal.args, ['/select,"C:\\work\\out.csv"'], 'quoted for Explorer, a path with spaces included');
  assert.equal(winReveal.verbatim, true, 'passed as is: node\'s own quoting sends Explorer to Documents');

  assert.deepEqual(openCommand('/tmp/a.pdf', { platform: 'darwin' }), { command: 'open', args: ['/tmp/a.pdf'] });
  assert.deepEqual(openCommand('/tmp/a.pdf', { platform: 'darwin', reveal: true }), { command: 'open', args: ['-R', '/tmp/a.pdf'] });

  assert.deepEqual(openCommand('/tmp/a.pdf', { platform: 'linux' }), { command: 'xdg-open', args: ['/tmp/a.pdf'] });
  assert.deepEqual(openCommand('/tmp/a.pdf', { platform: 'linux', reveal: true }), { command: 'xdg-open', args: [path.dirname('/tmp/a.pdf')] });
});

test('openLocalPath runs the planned command and surfaces a launcher failure', async () => {
  const calls = [];
  const run = async (command, args, options) => { calls.push({ command, args, options }); return { stdout: '', stderr: '' }; };
  await openLocalPath('/tmp/a.pdf', { platform: 'linux', run });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'xdg-open');
  assert.deepEqual(calls[0].args, ['/tmp/a.pdf']);
  assert.equal(calls[0].options.windowsHide, true);

  await assert.rejects(
    () => openLocalPath('/tmp/a.pdf', { platform: 'linux', run: async () => { throw new Error('no handler'); } }),
    error => error.code === 'OPEN_FAILED' && /no handler/.test(error.message)
  );
});

test('revealing on Windows is not a failure when explorer exits with 1', async () => {
  // explorer.exe returns 1 even after opening the folder.
  const exitOne = async () => { throw Object.assign(new Error('Command failed: explorer.exe'), { code: 1 }); };
  const plan = await openLocalPath('C:\\w\\a.txt', { platform: 'win32', reveal: true, run: exitOne });
  assert.equal(plan.command, 'explorer.exe');
  // windowsHide opened the folder as a hidden window: the operator saw nothing.
  const calls = [];
  await openLocalPath('C:\\w\\a b.txt', { platform: 'win32', reveal: true, run: async (command, args, options) => { calls.push(options); } });
  assert.equal(calls[0].windowsHide, false, 'the Explorer window is shown');
  assert.equal(calls[0].windowsVerbatimArguments, true);
  await assert.rejects(
    () => openLocalPath('C:\\w\\a.txt', { platform: 'win32', run: exitOne }),
    error => error.code === 'OPEN_FAILED',
    'a real launcher failure still surfaces'
  );
});

test('scriptCommand picks an interpreter by extension and platform', () => {
  assert.equal(scriptCommand('/w/build.bat', { platform: 'win32' }).command, 'cmd.exe');
  assert.deepEqual(scriptCommand('/w/task.ps1', { platform: 'win32' }).args, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '/w/task.ps1']);
  assert.equal(scriptCommand('/w/task.ps1', { platform: 'linux' }).command, 'pwsh');
  assert.equal(scriptCommand('/w/go.sh', { platform: 'linux' }).command, 'sh');
  assert.equal(scriptCommand('/w/go.sh', { platform: 'win32' }).command, 'bash', 'Git Bash on Windows');
  assert.equal(scriptCommand('/w/go.py', { platform: 'linux' }).command, 'python3');
  assert.equal(scriptCommand('/w/go.py', { platform: 'win32' }).command, 'py');
  assert.equal(scriptCommand('/w/go.mjs', { platform: 'linux' }).command, process.execPath, 'node runs .js scripts itself');
  assert.equal(scriptCommand('/w/readme.txt', { platform: 'linux' }), null, 'an unknown extension is not guessed');
});

test('runLocalScript returns the outcome and refuses what it cannot run', async () => {
  const ok = await runLocalScript('/w/go.sh', { platform: 'linux', run: async () => ({ stdout: 'done\n', stderr: '' }) });
  assert.deepEqual(ok, { command: 'go.sh', exitCode: 0, stdout: 'done\n', stderr: '', timedOut: false });

  // A non-zero exit (and a timeout) is the script's result, not a server fault.
  const failed = await runLocalScript('/w/go.sh', { platform: 'linux', run: async () => { throw Object.assign(new Error('exit 3'), { code: 3, stdout: 'partial', stderr: 'boom' }); } });
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.stdout, 'partial');
  assert.equal(failed.stderr, 'boom');
  const timed = await runLocalScript('/w/go.sh', { platform: 'linux', run: async () => { throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM', stdout: '', stderr: '' }); } });
  assert.equal(timed.timedOut, true);
  assert.equal(timed.exitCode, null);

  await assert.rejects(
    () => runLocalScript('/w/go.sh', { platform: 'linux', run: async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); } }),
    error => error.code === 'SCRIPT_RUN_FAILED'
  );
  await assert.rejects(
    () => runLocalScript('/w/readme.txt', { platform: 'linux' }),
    error => error.code === 'SCRIPT_NOT_RUNNABLE'
  );
});

test('shellCommand uses the machine shell, and runShellCommand reports the outcome', async () => {
  assert.deepEqual(shellCommand('ls -la', { platform: 'linux' }), { command: 'sh', args: ['-c', 'ls -la'] });
  assert.deepEqual(shellCommand('dir', { platform: 'win32' }), { command: 'cmd.exe', args: ['/d', '/s', '/c', 'dir'] });

  const ok = await runShellCommand('echo hi', { platform: 'linux', run: async () => ({ stdout: 'hi\n', stderr: '' }) });
  assert.deepEqual(ok, { exitCode: 0, stdout: 'hi\n', stderr: '', timedOut: false });

  const failed = await runShellCommand('false', { platform: 'linux', run: async () => { throw Object.assign(new Error('exit 1'), { code: 1, stdout: '', stderr: 'nope' }); } });
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.stderr, 'nope');

  await assert.rejects(() => runShellCommand('   ', { platform: 'linux' }), error => error.code === 'INPUT_INVALID');
  await assert.rejects(
    () => runShellCommand('echo', { platform: 'linux', run: async () => { throw Object.assign(new Error('no shell'), { code: 'ENOENT' }); } }),
    error => error.code === 'SHELL_RUN_FAILED'
  );
});

test('a multi-line command becomes a batch file on Windows (cmd runs only the first line of /c)', async () => {
  // The bug this pins: `cmd /c "cd …\npowershell …"` used to run only the cd,
  // so the button reported "no output" while the console showed a full run.
  const writes = [];
  const removed = [];
  const calls = [];
  const command = 'cd C:\work\sort\npowershell -ExecutionPolicy Bypass -File apply-move-list.ps1 -Csv plan-media.csv';
  const result = await runShellCommand(command, {
    platform: 'win32', cwd: 'C:/work/sort', outputEncoding: 'utf-8',
    run: async (cmd, args, options) => { calls.push({ cmd, args, options }); return { stdout: 'Rows: 299\n', stderr: '' }; },
    writeFile: async (file, data) => { writes.push({ file, data }); },
    removeFile: async (file) => { removed.push(file); },
    tempDir: 'C:/tmp', makeId: () => 'fixed-id'
  });

  assert.equal(writes.length, 1, 'the whole block is written to one file');
  assert.match(writes[0].file, /taskbridge-cmd-fixed-id\.cmd$/);
  assert.equal(writes[0].data, `@echo off\r\nchcp 65001 >nul\r\n${command}\r\n`, 'echo off, UTF-8 code page, then the whole multi-line block');
  assert.equal(calls[0].cmd, 'cmd.exe');
  assert.deepEqual(calls[0].args, ['/d', '/s', '/c', writes[0].file], 'the .cmd file is what runs');
  assert.equal(calls[0].options.cwd, 'C:/work/sort');
  assert.equal(result.stdout, 'Rows: 299\n');
  assert.equal(removed.length, 1, 'the temp file is cleaned up');

  // POSIX needs no file: sh -c runs the whole block, newlines included.
  const posixWrites = [];
  await runShellCommand('a\nb', { platform: 'linux', run: async () => ({ stdout: '', stderr: '' }), writeFile: async () => posixWrites.push(true) });
  assert.equal(posixWrites.length, 0);
});

test('shell output is decoded, so raw bytes never reach the UI as mojibake', async () => {
  // A Buffer is decoded with the requested encoding (the shell uses UTF-8 via
  // chcp 65001; the override is what a cp866 stream would need).
  const bytes = Buffer.from('Текущая страница', 'utf8');
  const result = await runShellCommand('chcp', {
    platform: 'win32', outputEncoding: 'utf-8',
    writeFile: async () => {}, removeFile: async () => {},
    run: async () => ({ stdout: bytes, stderr: Buffer.alloc(0) })
  });
  assert.equal(result.stdout, 'Текущая страница', 'bytes are decoded, not stringified');

  const cp866 = Buffer.from([0x92, 0xa5, 0xaa, 0xe3, 0xe9, 0xa0, 0xef]);
  const legacy = await runShellCommand('x', {
    platform: 'win32', outputEncoding: 'cp866',
    writeFile: async () => {}, removeFile: async () => {},
    run: async () => ({ stdout: cp866, stderr: Buffer.alloc(0) })
  });
  assert.equal(legacy.stdout, 'Текущая', 'an OEM stream decodes with its code page');
});
