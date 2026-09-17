import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// One UI for both realities (docs/cloud-ui.md): the machine, the cloud dev host
// and the Vercel deployment must all serve the very same files in web/. These
// checks are what stops a second, quietly diverging copy from reappearing.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFile(path.join(root, name), 'utf8');
const exists = name => fs.access(path.join(root, name)).then(() => true, () => false);

test('the deployment serves the shared web/, with session links falling back to the shell', async () => {
  const vercel = JSON.parse(await read('vercel.json'));
  assert.equal(vercel.outputDirectory, 'web', 'Vercel must publish the shared UI, not a copy');
  const sources = vercel.rewrites.map(rule => rule.source);
  assert.ok(sources.includes('/api/:path*'), 'the API must stay routed to the function');
  const session = vercel.rewrites.find(rule => rule.source === '/session/:id');
  assert.equal(session?.destination, '/index.html', 'a session address must open the app shell');
  // The pairing link is a client route too: the token lives in its fragment,
  // which never reaches the server, so the shell has to load and read it.
  assert.equal(vercel.rewrites.find(rule => rule.source === '/pair')?.destination, '/index.html');
  assert.ok(vercel.rewrites.indexOf(session) > sources.indexOf('/api/:path*'), 'the API rule must win over the shell');
});

test('the legacy cloud UI copy is gone and nothing points at it any more', async () => {
  assert.equal(await exists('cloud/web'), false, 'cloud/web must not come back: it is the same app');
  const checked = JSON.parse(await read('package.json')).scripts.check;
  assert.doesNotMatch(checked, /cloud\/web/, 'npm run check must not reference the deleted copy');
  for (const file of ['web/app.js', 'web/sw.js', 'web/cloud-config.js', 'web/transport.mjs']) {
    assert.match(checked, new RegExp(file.replace('/', '\\/')), `${file} must be syntax-checked`);
  }
});

test('the shell loads the cloud config before the app, and caches only files that exist', async () => {
  const html = await read('web/index.html');
  const config = html.indexOf('/cloud-config.js');
  const app = html.indexOf('type="module" src="/app.js?v=20260916-32"');
  assert.ok(config > 0 && app > 0, 'both scripts must be in the shell');
  // A classic script runs before a deferred module: app.js picks its transport
  // from the config, so the order is load-bearing, not cosmetic.
  assert.ok(config < app, 'cloud-config.js must come before the module');
  // No inline <script> anywhere in the shell: the server sends script-src 'self',
  // so an inline block is blocked by the browser and simply never runs.
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/, 'inline scripts are blocked by the CSP');
  assert.match(await read('web/cloud-config.js'), /navigator\.serviceWorker\.register\('\/sw\.js\?v=20260916-32'/, 'the PWA must install the current shell revision from an external script');

  const shell = (await read('web/sw.js')).match(/const SHELL = \[([^\]]+)\]/s)[1]
    .split(',').map(entry => entry.trim().replace(/^'|'$/g, '')).filter(Boolean);
  for (const asset of shell) {
    if (asset === '/') continue;
    assert.ok(await exists(path.join('web', asset.split('?')[0])), `sw.js precaches a missing file: ${asset}`);
  }
});

test('a failed service-worker upgrade cannot replace the working offline shell', async () => {
  const source = await read('web/sw.js');
  const listeners = {};
  let skipped = false;
  const self = {
    addEventListener: (type, handler) => { listeners[type] = handler; },
    skipWaiting: () => { skipped = true; },
    clients: { claim: async () => {} },
    location: { origin: 'https://taskbridge.test' },
  };
  const caches = { open: async () => ({ addAll: async () => { throw new Error('offline'); } }) };
  vm.runInNewContext(source, { self, caches, URL, Request, fetch: async () => { throw new Error('offline'); } });
  let installation;
  listeners.install({ waitUntil: promise => { installation = promise; } });
  await assert.rejects(installation, /offline/);
  assert.equal(skipped, false, 'an incomplete cache must not activate');
});

test('a complete service-worker upgrade activates before removing the old cache', async () => {
  const source = await read('web/sw.js');
  const listeners = {};
  const actions = [];
  const self = {
    addEventListener: (type, handler) => { listeners[type] = handler; },
    skipWaiting: async () => { actions.push('skip'); },
    clients: { claim: async () => { actions.push('claim'); } },
    location: { origin: 'https://taskbridge.test' },
  };
  const currentCache = source.match(/const CACHE = ['"]([^'"]+)['"]/)?.[1] || 'taskbridge-v2';
  const caches = {
    open: async () => ({ addAll: async () => { actions.push('cached'); } }),
    keys: async () => ['taskbridge-v1', currentCache],
    delete: async key => { actions.push(`delete:${key}`); },
  };
  vm.runInNewContext(source, { self, caches, URL, Request, fetch: async () => ({ ok: true, clone() { return this; } }) });
  let installation;
  listeners.install({ waitUntil: promise => { installation = promise; } });
  await installation;
  let activation;
  listeners.activate({ waitUntil: promise => { activation = promise; } });
  await activation;
  assert.deepEqual(actions, ['cached', 'skip', 'delete:taskbridge-v1', 'claim']);
});

test('the cloud dev host serves the same shell and the same app.js as the machine', async () => {
  const { startServer } = await import('../cloud/server.mjs');
  const running = await startServer({ port: 0, host: '127.0.0.1', storeTarget: 'memory:', env: {}, logger: () => {} });
  const port = running.port;
  const get = async (urlPath) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, res => {
      // Collect Buffers and decode once: `body += chunk` decodes each TCP chunk
      // on its own, so a multi-byte character split across a chunk boundary
      // becomes replacement characters and the byte-for-byte check fails at
      // random (the file is served correctly — only the test mangled it).
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
  try {
    const [index, app, session] = await Promise.all([get('/'), get('/app.js'), get('/session/abc123')]);
    assert.equal(index.status, 200);
    assert.equal(index.body, await read('web/index.html'), 'the cloud host serves the shared shell byte for byte');
    assert.equal(app.body, await read('web/app.js'), 'and the shared app, not a trimmed copy');
    assert.equal(session.body, index.body, 'a session link opens the shell here too');
  } finally {
    await running.close();
  }
});

test('cloud-config only speaks up on a public origin and only after pairing', async () => {
  const source = await read('web/cloud-config.js');
  const run = (hostname, stored, { pathname = '/', hash = '' } = {}) => {
    const window = {};
    const store = { value: stored, written: null, replaced: null };
    const location = { hostname, protocol: 'https:', host: 'taskbridge.example.app', pathname, hash };
    const localStorage = { getItem: () => store.value, setItem: (key, value) => { store.written = { key, value }; store.value = value; } };
    const history = { replaceState: (state, title, url) => { store.replaced = url; } };
    new Function('location', 'localStorage', 'window', 'history', source)(location, localStorage, window, history);
    return { cloud: window.__TASKBRIDGE_CLOUD__, store };
  };
  const paired = JSON.stringify({ machineId: 'home-pc', deviceToken: 'token-1' });
  assert.equal(run('localhost', paired).cloud, undefined, 'on the machine the page talks to its own origin');
  assert.equal(run('192.168.1.212', paired).cloud, undefined, 'the LAN is the machine too');
  assert.equal(run('taskbridge.example.app', null).cloud, undefined, 'no pairing yet: no half-configured transport');
  assert.equal(run('taskbridge.example.app', '{').cloud, undefined, 'a corrupted record is ignored, not thrown');
  assert.deepEqual(run('taskbridge.example.app', paired).cloud, {
    url: 'wss://taskbridge.example.app/api/relay', machineId: 'home-pc', deviceToken: 'token-1'
  });
});

test('scanning the QR stores the credential and takes it out of the address bar', async () => {
  const source = await read('web/cloud-config.js');
  const open = (pathname, hash, stored = null) => {
    const window = {};
    const store = { value: stored, replaced: null };
    const location = { hostname: 'taskbridge.example.app', protocol: 'https:', host: 'taskbridge.example.app', pathname, hash };
    const localStorage = { getItem: () => store.value, setItem: (key, value) => { store.value = value; } };
    const history = { replaceState: (state, title, url) => { store.replaced = url; } };
    new Function('location', 'localStorage', 'window', 'history', source)(location, localStorage, window, history);
    return { cloud: window.__TASKBRIDGE_CLOUD__, store };
  };

  const link = '#m=home-pc&t=v1.payload.signature&r=wss%3A%2F%2Frelay.example.app%2Fapi%2Frelay';
  const paired = open('/pair', link);
  assert.deepEqual(paired.cloud, {
    url: 'wss://relay.example.app/api/relay', machineId: 'home-pc', deviceToken: 'v1.payload.signature'
  }, 'the scanned device is connected straight away');
  assert.equal(JSON.parse(paired.store.value).deviceToken, 'v1.payload.signature', 'and remembered for the next visit');
  // The credential must not stay in the address bar or in history.
  assert.equal(paired.store.replaced, '/');

  // A pairing link without a token changes nothing — no half-written record.
  const broken = open('/pair', '#m=home-pc');
  assert.equal(broken.cloud, undefined);
  assert.equal(broken.store.value, null);

  // The same fragment on an ordinary page is not a pairing link.
  const elsewhere = open('/', link);
  assert.equal(elsewhere.cloud, undefined);
  assert.equal(elsewhere.store.value, null);
});
