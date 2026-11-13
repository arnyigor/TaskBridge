# Private remote access with Tailscale Serve

TaskBridge runs commands with the Windows user's permissions. Do not publish its
HTTP ports, enable Funnel, or forward them on the router.

## Configuration

Install Tailscale on Windows and Android, join the same tailnet, and restrict
access to the Windows device's TCP 443 with Tailscale Grants. These are operator
steps; TaskBridge does not install Tailscale or change tailnet policy.

Merge into `config.json` (keep other settings, especially the working LAN bind).
This example retains LAN on `0.0.0.0`; the split app itself remains loopback-only:

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 8787,
    "auth": { "enabled": true },
    "tailscale": {
      "enabled": true,
      "servePort": 8788,
      "httpsUrl": "https://YOUR-ACTUAL-DEVICE.YOUR-TAILNET.ts.net"
    }
  }
}
```

Use the real HTTPS URL from Serve, not the placeholder. `httpsUrl` advertises the
address in the pairing QR; it does not configure Serve. If Serve rewrites Host,
add this exact HTTPS origin to `server.auth.allowedOrigins` for browser POSTs.

Start the split app/proxy via `node scripts/start-lan.mjs start` (or `run`). The
extra ingress is part of the proxy process, bound only to `127.0.0.1:8788`, and is
not started when auth is disabled. Ordinary `npm start` does not start it.

```powershell
tailscale serve --bg 8788
tailscale serve status
```

Check the installed Tailscale CLI's help if its syntax differs. Target **8788**,
never 8787 or the internal app port. Serve must remain tailnet-only, without
Funnel. Enter the HTTPS URL on Android or in a browser and pair using the code
shown locally on the PC. No running TaskBridge process is restarted by this
configuration change; apply it during an operator-controlled restart.

Do not change a working LAN bind to `127.0.0.1` when adding Serve. Only the new
Serve listener is loopback-only. If its port is busy or invalid, the proxy logs
`Serve ingress disabled` and leaves LAN running; the launcher does not stop LAN
because this optional listener failed. Existing local/LAN classification is retained.

## Trust boundary and checks

The Serve ingress overwrites its remote marker and forwarded protocol, regardless
of supplied Host, XFF or identity headers. Such requests cannot read the pairing
code or use machine-only file-opening actions, even with a valid device token.
Pairing, authenticated task execution, uploads and SSE remain available. Browser
pairing sets Secure cookies behind the HTTPS terminator. Native clients use Bearer.

The ingress conservatively uses one pairing-attempt bucket when Serve's socket
peer is loopback. Five wrong codes can block pairing for all Serve clients for ten
minutes. This avoids trusting forgeable client headers for brute-force protection;
restrict tailnet access with Grants. Existing paired tokens are unaffected.

Tests use real HTTP proxies and a fake Pi process, not a real VPN or Android:

```text
node --test --test-force-exit tests/remote-access.test.mjs tests/proxy.test.mjs tests/lan-mode.test.mjs
```

Before relying on remote access, manually check HTTPS certificate validation,
Grants, pairing, uploads, task/SSE/STOP, proxy restart, and Wi-Fi ↔ mobile handoff.
An unavailable VPN must leave the selected HTTPS endpoint unavailable; do not
configure an automatic fallback to a public HTTP endpoint. TaskBridge does not
manage the VPN or perform such a fallback.
