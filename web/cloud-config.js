// The same web/ is served by the machine itself and by the cloud CDN
// (docs/cloud-ui.md). A classic script runs before the deferred app.js module,
// so the transport choice in app.js already sees the answer.
//
// On the machine (localhost/LAN) there is nothing to configure: the page talks
// to its own origin. Served from a public address, the page needs the relay URL
// and this device's credentials — they arrive once, by scanning the QR the PC
// shows, and then live in localStorage. Nothing is baked into the deployment.
(function () {
  var KEY = 'taskbridge.cloud';

  function local(host) {
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === ''
      || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  }

  // The QR points at <cloud>/pair#m=<machineId>&t=<deviceToken>&r=<relay wss>.
  // A fragment is never sent to a server, so the token stays between the PC
  // screen and this phone even though the cloud served the page.
  function claimPairingLink() {
    if (location.pathname !== '/pair' && location.pathname !== '/pair/') return null;
    var params = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    var machineId = params.get('m');
    var deviceToken = params.get('t');
    if (!machineId || !deviceToken) return null;
    var record = { machineId: machineId, deviceToken: deviceToken, url: params.get('r') || '', pairedAt: new Date().toISOString() };
    try { localStorage.setItem(KEY, JSON.stringify(record)); } catch (error) { return null; }
    // Drop the credential out of the address bar (and out of history) as soon
    // as it is stored, then continue into the app itself.
    history.replaceState(null, '', '/');
    return record;
  }

  var saved = claimPairingLink();
  if (!saved) {
    try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (error) { saved = null; }
  }

  if (local(location.hostname)) return;
  // No pairing yet: the app still loads and can explain how to connect, instead
  // of failing into a blank page.
  if (!saved || !saved.machineId || !saved.deviceToken) return;

  window.__TASKBRIDGE_CLOUD__ = {
    // The relay lives on the same deployment that served this page.
    url: saved.url || (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/relay',
    machineId: saved.machineId,
    deviceToken: saved.deviceToken
  };
})();

// The service worker is registered from here, not from an inline <script>: the
// server sends script-src 'self', so an inline block is silently blocked and the
// PWA would never install (found by running it, not by reading it).
(function () {
  if (!('serviceWorker' in navigator)) return;
  // The phone kept running a stale shell after a deploy — the code-block actions
  // and the paste handling simply "did not exist" there until the cache was
  // cleared by hand. Reload once when a new worker takes control, so a deploy
  // reaches the phone by itself. `hadController` keeps the very first install
  // (which also fires controllerchange) from reloading a freshly opened page.
  var hadController = !!navigator.serviceWorker.controller;
  var reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!hadController || reloaded) return;
    reloaded = true;
    location.reload();
  });
  addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js?v=20260916-31', { updateViaCache: 'none' }).then(function (registration) {
      // Ask for a fresh sw.js on every load; it is tiny and the browser otherwise
      // only re-checks it on its own schedule.
      if (registration.update) registration.update().catch(function () {});
    }).catch(function (error) {
      console.warn('service worker registration failed', error);
    });
  });
})();
