// Offline shell for the one shared UI (docs/cloud-ui.md). Only the shell is
// cached: session data is never stored here, because a stale task list is worse
// than an honest "machine offline" — the app always re-syncs after its cursor.

const CACHE = 'taskbridge-v3';
const SHELL = [
  '/', '/index.html', '/app.js?v=20260915-2', '/app.css?v=20260915-2', '/chat-state.mjs', '/transport.mjs',
  '/cloud-config.js', '/manifest.webmanifest', '/icon.svg',
  '/vendor/marked.js', '/vendor/purify.mjs'
];

self.addEventListener('install', (event) => {
  // A failed upgrade must keep the working worker/cache, not activate an
  // incomplete shell and delete the only offline copy.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
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

// Web Push (§ notifications). The machine encrypts the text for this browser
// alone, so the payload arrives readable here and nowhere in between.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (error) { data = {}; }
  const title = data.title || 'TaskBridge';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    // One notification per session: a new state replaces the previous line
    // instead of stacking five of them.
    tag: data.taskId || 'taskbridge',
    renotify: Boolean(data.taskId),
    data: { taskId: data.taskId || null, type: data.type || null },
    icon: '/icon.svg',
    badge: '/icon.svg'
  }));
});

// Tapping the notification opens that session — reusing an already open tab.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const taskId = event.notification.data && event.notification.data.taskId;
  const target = taskId ? `/session/${encodeURIComponent(taskId)}` : '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        return client.focus().then(() => client.navigate ? client.navigate(target) : client);
      }
    }
    return self.clients.openWindow(target);
  }));
});
