#!/usr/bin/env node
// Records the real RPC exchange between TaskBridge and Pi (backend plan B0).
//
// A pass-through stand-in for `pi`: TaskBridge starts this script instead of
// Pi, the script starts the real Pi with the same arguments and copies every
// stdin/stdout/stderr line both ways, appending each one to a transcript:
//
//   {"t":12.345,"dir":"in","line":"{\"type\":\"prompt\",...}"}
//   {"t":12.401,"dir":"out","line":"{\"type\":\"response\",...}"}
//   {"t":12.402,"dir":"err","line":"..."}
//   {"t":30.000,"dir":"exit","code":0,"signal":null}
//
// `t` is seconds since start. Lines are recorded verbatim (a broken JSON line
// stays broken), so a transcript can later be replayed by fake-pi.
//
// Use it by pointing config.json at it (absolute paths, since Pi runs in the
// task workspace):
//
//   Windows (Pi is started through the shell there):
//     "pi": { "command": "node C:/path/to/Taskbridge/scripts/pi-rpc-record.mjs" }
//   Linux / macOS (no shell; the script is executable and has a shebang):
//     "pi": { "command": "/path/to/Taskbridge/scripts/pi-rpc-record.mjs" }
//
// Environment:
//   PI_REAL_COMMAND  the real Pi (default: pi)
//   PI_RECORD_DIR    where transcripts go (default: <repo>/data/pi-rpc-records)
//
// One file per Pi process: <timestamp>-<pid>.jsonl. Transcripts contain the
// prompts, file paths and model output of the session — review them before
// sharing.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const realCommand = process.env.PI_REAL_COMMAND || 'pi';
const dir = path.resolve(process.env.PI_RECORD_DIR || path.join(ROOT, 'data', 'pi-rpc-records'));
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.jsonl`);
const out = fs.createWriteStream(file, { flags: 'a' });
const started = process.hrtime.bigint();
const record = (entry) => {
  const t = Number(process.hrtime.bigint() - started) / 1e9;
  out.write(JSON.stringify({ t: Math.round(t * 1000) / 1000, ...entry }) + '\n');
};
record({ dir: 'start', command: realCommand, args: process.argv.slice(2), cwd: process.cwd() });

const pi = spawn(realCommand, process.argv.slice(2), {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  shell: process.platform === 'win32',
});

// Split a byte stream into lines without breaking multi-byte characters, and
// pass the bytes through untouched so the parent sees exactly what Pi wrote.
function tap(stream, sink, direction) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  stream.on('data', (chunk) => {
    sink.write(chunk);
    buffer += decoder.write(chunk);
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      record({ dir: direction, line: buffer.slice(0, index).replace(/\r$/, '') });
      buffer = buffer.slice(index + 1);
    }
  });
  stream.on('end', () => {
    buffer += decoder.end();
    if (buffer) record({ dir: direction, line: buffer, partial: true });
    if (sink !== process.stdout && sink !== process.stderr) sink.end();
  });
}

// A closed pipe on either side is the other end going away (TaskBridge exited,
// or Pi did): record it and stop Pi rather than crash with EPIPE.
const onPipeError = (where) => (error) => {
  record({ dir: 'pipe-error', where, code: error.code || null, message: error.message });
  if (where === 'stdout') { try { pi.kill(); } catch { /* gone */ } }
};
process.stdout.on('error', onPipeError('stdout'));
pi.stdin.on('error', onPipeError('pi-stdin'));

tap(process.stdin, pi.stdin, 'in');
tap(pi.stdout, process.stdout, 'out');
tap(pi.stderr, process.stderr, 'err');

pi.on('error', (error) => {
  record({ dir: 'error', message: error.message });
  process.stderr.write(`pi-rpc-record: cannot start ${realCommand}: ${error.message}\n`);
  out.end(() => process.exit(127));
});
pi.on('close', (code, signal) => {
  record({ dir: 'exit', code, signal });
  out.end(() => process.exit(code ?? 1));
});
// Forward termination so stopping TaskBridge stops the real Pi too.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { try { pi.kill(signal); } catch { /* gone */ } });
}
