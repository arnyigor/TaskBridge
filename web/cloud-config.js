// The same web/ is served by the machine itself and by the cloud CDN
// (docs/cloud-ui.md). A classic script runs before the deferred app.js module,
// so the transport choice in app.js already sees the answer.
//
// On the machine (localhost/LAN) there is nothing to configure: the page talks
// to its own origin. Served from a public address, the page needs the relay URL
// and this device's credentials — written here by pairing and kept in
// localStorage, never baked into the deployment.
(function () {
  var host = location.hostname;
  var local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === ''
    || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  if (local) return;

  var saved = null;
  try { saved = JSON.parse(localStorage.getItem('taskbridge.cloud') || 'null'); } catch (error) { saved = null; }
  // No pairing yet: the app still loads and shows its own "connect this device"
  // path instead of a blank page.
  if (!saved || !saved.machineId || !saved.deviceToken) return;

  window.__TASKBRIDGE_CLOUD__ = {
    // The relay lives on the same deployment that served this page.
    url: saved.url || (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/relay',
    machineId: saved.machineId,
    deviceToken: saved.deviceToken
  };
})();
