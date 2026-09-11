// Offline shell for the one shared UI (docs/cloud-ui.md). Only the shell is
// cached: session data is never stored here, because a stale task list is worse
// than an honest "machine offline" — the app always re-syncs after its cursor.

const CACHE = 'taskbridge-v1';
const SHELL = [
  '/', '/index.html', '/app.js', '/app.css', '/chat-state.mjs', '/transport.mjs',
  '/cloud-config.js', '/manifest.webmanifest', '/icon.svg',
  '/vendor/marked.js', '/vendor/purify.mjs'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // always live
  // A session address is the app shell itself; the session is loaded by the app.
  const shellRoute = url.pathname.startsWith('/session/') || url.pathname === '/pair';
  const request = shellRoute ? new Request('/index.html') : event.request;
  // Network first, cache as the fallback: the shell must update itself as soon
  // as the machine (or the deployment) serves a new build.
  event.respondWith(
    fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
      }
      return response;
    }).catch(() => caches.match(request).then(cached => cached || caches.match('/index.html')))
  );
});
