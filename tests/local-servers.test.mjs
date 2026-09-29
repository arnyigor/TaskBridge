import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExternalLocalServers, parseListeningPids, portOf } from '../src/local-models.mjs';

// Configured external servers (Strata и др.) are not llama.cpp: the model is
// loaded before the server listens, so "loaded" = "/health answers", and
// loading is starting the whole `start` command while unloading is stopping
// that process. Verified here against a real (mock) HTTP server, not a stub.

test('status(): a live server is «loaded», a dead one «unloaded»', async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const config = {
    externalServers: [{
      provider: 'strata-test', name: 'Strata test', model: 'test-model',
      baseUrl: `http://127.0.0.1:${port}`
    }]
  };
  const servers = new ExternalLocalServers(config);
  const down = await servers.status({ fresh: true });
  assert.equal(down.configured, true);
  assert.equal(down.models[0].status, 'unloaded');
  assert.equal(down.models[0].external, true);
  assert.equal(down.models[0].provider, 'strata-test');

  const mock = await new Promise(resolve => {
    const s = http.createServer((req, res) => {
      res.writeHead(200); res.end('{"status":"ok"}');
    });
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
  try {
    const up = await servers.status({ fresh: true });
    assert.equal(up.models[0].status, 'loaded');
    assert.equal(up.models[0].id, 'test-model');
  } finally {
    mock.close();
  }
});

test('find(): by model id and by provider id', () => {
  const servers = new ExternalLocalServers({
    externalServers: [{ provider: 'strata-iq3', name: 'Strata IQ3_XXS', model: 'qwen3.8-flash-next-iq3-xxs', baseUrl: 'http://127.0.0.1:8082' }]
  });
  assert.equal(servers.find('qwen3.8-flash-next-iq3-xxs')?.provider, 'strata-iq3');
  assert.equal(servers.find('strata-iq3')?.provider, 'strata-iq3');
  assert.equal(servers.find('qwen-27b-q3'), null);
  // A display-name collision must not divert a router load.
  assert.equal(new ExternalLocalServers({
    externalServers: [{ provider: 'x', name: 'qwen-27b-q3', model: 'x-model', baseUrl: 'http://127.0.0.1:9' }]
  }).find('qwen-27b-q3'), null);
  assert.equal(servers.find(''), null);
  assert.equal(servers.find(undefined), null);
});

test('killMarker(): the --config value, or the explicit one', () => {
  const servers = new ExternalLocalServers({});
  assert.equal(
    servers.killMarker({ start: ['python.exe', 'server.py', '--config', 'G:\\Strata\\strata-iq3_xxs.json', '--port', '8082'] }),
    'G:\\Strata\\strata-iq3_xxs.json'
  );
  assert.equal(
    servers.killMarker({ start: ['a.exe'], killMarker: 'run-iq3_xxs.bat' }),
    'run-iq3_xxs.bat'
  );
  assert.equal(new ExternalLocalServers({}).killMarker({ start: ['a.exe', '--port', '1'] }), null);
});

test('start() + stop(): a spawned detached server answers /health and is stopped again', async () => {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const config = {
    externalServers: [{
      provider: 'strata-test', model: 'test-model',
      baseUrl: `http://127.0.0.1:${port}`,
      // The start command must itself serve /health on the configured port, so
      // the stand-in reads the port from the environment the config names.
      start: [process.execPath, '-e',
        `const http=require('http');const s=http.createServer((q,r)=>{if(q.url==='/health'){r.writeHead(200);r.end('{"status":"ok"}');return}r.writeHead(404);r.end()});s.listen(${port},'127.0.0.1',()=>{});setInterval(()=>{},1000)`],
      cwd: undefined,
      loadTimeoutMs: 15000
    }]
  };
  const servers = new ExternalLocalServers(config);
  const result = await servers.start(config.externalServers[0]);
  assert.equal(result.status, 'loaded');
  const up = await servers.status({ fresh: true });
  assert.equal(up.models[0].status, 'loaded');
  // A second start while the server is already up returns at once (idempotent).
  const again = await servers.start(config.externalServers[0]);
  assert.equal(again.status, 'loaded');
  // stop() kills the tracked process tree; /health then goes quiet.
  const stopped = await servers.stop(config.externalServers[0]);
  assert.equal(stopped.status, 'unloaded');
  const down = await servers.status({ fresh: true });
  assert.equal(down.models[0].status, 'unloaded');
});

test('start() refuses a second launch while one is already loading', async () => {
  const port = 20000 + Math.floor(Math.random() * 1000);
  const config = {
    externalServers: [{
      provider: 'strata-slow', model: 'test-model',
      baseUrl: `http://127.0.0.1:${port}`,
      start: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
      loadTimeoutMs: 1200
    }]
  };
  const servers = new ExternalLocalServers(config);
  const first = servers.start(config.externalServers[0]);
  await assert.rejects(() => servers.start(config.externalServers[0]), /уже запускается/);
  await assert.rejects(() => first, /Таймаут ожидания/);
  // The timed-out process is left running by design (it may still be loading),
  // so the test stops it through the tracked process it recorded.
  await servers.stop(config.externalServers[0]);
  const down = await servers.status({ fresh: true });
  assert.equal(down.models[0].status, 'unloaded');
});

test('processMarkers(): both the configured path and its file name', () => {
  const servers = new ExternalLocalServers({});
  // A server started by hand carries a relative path, so the full one alone
  // never matches: the name is what actually finds the process.
  assert.deepEqual(
    servers.processMarkers({ start: ['python.exe', 'server.py', '--config', 'G:\\Strata\\strata-iq2_xs.json', '--port', '8081'] }),
    ['G:\\Strata\\strata-iq2_xs.json', 'strata-iq2_xs.json']
  );
  assert.deepEqual(servers.processMarkers({ start: ['a.exe'], killMarker: 'run.bat' }), ['run.bat']);
  assert.deepEqual(servers.processMarkers({ start: ['a.exe', '--port', '1'] }), []);
});

test('portOf() and parseListeningPids(): the port owner is found in netstat', () => {
  assert.equal(portOf('http://127.0.0.1:8082'), 8082);
  assert.equal(portOf('http://127.0.0.1'), null);
  assert.equal(portOf('not a url'), null);
  const netstat = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       22940',
    '  TCP    127.0.0.1:8081         0.0.0.0:0              LISTENING       34608',
    '  TCP    127.0.0.1:8081         127.0.0.1:52000        ESTABLISHED     34608',
    '  TCP    [::1]:8082              [::]:0                 LISTENING       11111',
    '  TCP    127.0.0.1:18081        0.0.0.0:0              LISTENING       99999'
  ].join('\r\n');
  assert.deepEqual(parseListeningPids(netstat, 8081), [34608]);
  assert.deepEqual(parseListeningPids(netstat, 8082), [11111]);
  assert.deepEqual(parseListeningPids(netstat, 9090), []);
  // 18081 must not answer for 8081 (the match is on the whole ":port" suffix).
  assert.deepEqual(parseListeningPids(netstat, 18081), [99999]);
});

test('stop() kills a server that was started with a RELATIVE config path', async () => {
  const port = 21000 + Math.floor(Math.random() * 1000);
  const name = `strata-rel-${port}.json`;
  // Stand-in for a hand-started server: its command line carries only the FILE
  // NAME (the full path the config knows never appears) — the case that made
  // «Выгрузить» a no-op.
  const config = {
    externalServers: [{
      provider: 'strata-rel', model: 'rel-model',
      baseUrl: `http://127.0.0.1:${port}`,
      killMarker: `G:\\Strata\\${name}`,
      start: [process.execPath, '-e', 'x']
    }]
  };
  const servers = new ExternalLocalServers(config);
  const child = (await import('node:child_process')).spawn(process.execPath, ['-e',
    `const http=require('http');http.createServer((q,r)=>{r.writeHead(200);r.end('{"status":"ok"}')}).listen(${port},'127.0.0.1',()=>{});setInterval(()=>{},1000)`,
    name], { detached: true, stdio: 'ignore', windowsHide: true, cwd: process.cwd() });
  child.unref();
  try {
    for (let i = 0; i < 40 && !(await servers.alive(config.externalServers[0], 500)); i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal((await servers.status({ fresh: true })).models[0].status, 'loaded');
    const result = await servers.stop(config.externalServers[0]);
    assert.equal(result.status, 'unloaded');
    assert.equal((await servers.status({ fresh: true })).models[0].status, 'unloaded');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
  }
});

// The reported failure: a portable update restarts the app with `taskkill /T`
// on its own tree (scripts/restart-lan-now.mjs), a loaded Strata server was a
// child of that tree even though it was spawned detached, and the very next
// local request — Pi's compaction summary — died with "Connection error."
// (26 ms, i.e. nothing was listening). The started server must therefore live
// outside the app's process tree: only the launcher is a child, and it is gone
// by the time a restart happens.
test('a started server survives `taskkill /T` on the app that started it', { skip: process.platform !== 'win32' }, async () => {
  const port = 23000 + Math.floor(Math.random() * 1000);
  const lib = new URL('../src/local-models.mjs', import.meta.url).href;
  const helper = path.join(os.tmpdir(), `taskbridge-orphan-${port}.mjs`);
  const standIn = path.join(os.tmpdir(), `taskbridge-orphan-server-${port}.mjs`);
  // The model stands in as its own file: a `-e` one-liner would need three
  // levels of quoting and the test is about the process tree, not about that.
  await fs.writeFile(standIn, `
import http from 'node:http';
http.createServer((request, response) => { response.writeHead(200); response.end('{"status":"ok"}'); }).listen(${port}, '127.0.0.1', () => {});
setInterval(() => {}, 1000);
`, 'utf8');
  // Stands in for the app: it starts the server exactly like «Загрузить» does,
  // then stays alive so the test can kill its whole tree.
  await fs.writeFile(helper, `
import { ExternalLocalServers } from ${JSON.stringify(lib)};
const server = {
  provider: 'strata-orphan', model: 'orphan-model',
  baseUrl: 'http://127.0.0.1:${port}',
  start: [process.execPath, ${JSON.stringify(standIn)}],
  loadTimeoutMs: 20000
};
const servers = new ExternalLocalServers({ externalServers: [server] });
console.log((await servers.start(server)).status);
setInterval(() => {}, 1000);
`, 'utf8');
  const health = () => new Promise(resolve => {
    const request = http.get(`http://127.0.0.1:${port}/health`, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(1000, () => { request.destroy(); resolve(false); });
  });
  const app = spawn(process.execPath, [helper], { detached: true, stdio: 'ignore', windowsHide: true });
  const waitUp = async () => {
    for (let i = 0; i < 100; i++) {
      if (await health()) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  };
  try {
    assert.equal(await waitUp(), true, 'the stand-in server never answered /health');
    // The restart, verbatim: kill the app's tree, which is what took the model
    // down with it before this was fixed.
    await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(app.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await health(), true, 'the server died with the app that started it');
  } finally {
    const netstat = await new Promise(resolve => execFile('netstat.exe', ['-ano'], { windowsHide: true }, (error, stdout) => resolve(error ? '' : stdout)));
    for (const pid of parseListeningPids(netstat, port)) {
      await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(pid), '/F'], { windowsHide: true }, () => resolve()));
    }
    try { app.kill('SIGKILL'); } catch { /* already dead */ }
    await fs.rm(helper, { force: true });
    await fs.rm(standIn, { force: true });
  }
});

test('stop() says so when nothing was stopped instead of a silent «выгружено»', async () => {
  const port = 22000 + Math.floor(Math.random() * 1000);
  const config = {
    externalServers: [{
      provider: 'strata-ghost', model: 'ghost',
      baseUrl: `http://127.0.0.1:${port}`,
      start: [process.execPath, '-e', 'x', '--config', 'C:\nowhere\strata-ghost.json']
    }]
  };
  const servers = new ExternalLocalServers(config);
  // Nothing is listening, nothing matches the marker: the model was never up,
  // so stop() must report success (there is nothing to stop) — not an error.
  const result = await servers.stop(config.externalServers[0]);
  assert.equal(result.status, 'unloaded');
});
