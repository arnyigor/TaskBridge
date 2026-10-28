# DIST-05 — which Pi TaskBridge runs, and how its state is reported

## What changed

`src/pi-command.mjs` decides the Pi command once, for every consumer:

1. `pi.command` from the configuration — the operator's own setting, unchanged;
2. `TASKBRIDGE_PI` — an explicit path without editing `config.json`;
3. a bundled runtime when the layout really is the distribution (`<dist>/server` next to `TaskBridge.exe` and `app/`) — `<dist>/runtime/pi/pi.cmd`, or `runtime/pi/pi` inside the copied server tree;
4. `pi` from `PATH` — the historical behaviour.

The same resolver now feeds session launch (`task-manager`), model discovery (`model-catalog`) and the version probe, so `/api/info` cannot report a different Pi than the one the sessions start. A blank setting is ignored rather than being passed on as an empty binary name, and the binary name follows the platform.

`/api/info.pi` additionally carries `source` (`config` / `environment` / `bundled` / `path`) and `state` (`missing` / `incompatible` / `ready`, from `piRuntimeState`). That separates three different operator-facing situations that used to collapse into one: no Pi at all, an unsupported Pi version, and a ready runtime — none of them is the same as "model not configured".

## Verification

- `node --test --test-force-exit tests/pi-command.test.mjs` — **7 PASS**: configured command wins; blank setting is ignored; `TASKBRIDGE_PI` overrides without config; bundled runtime beats `PATH` and the server-tree copy beats the distribution copy; a plain checkout does not trust an unrelated neighbour's `runtime/pi`; platform naming; diagnostics states.
- `node --test --test-force-exit tests/pi-version.test.mjs` — **5 PASS, 1 SKIP** (the POSIX-only case), so the probe still behaves.
- `npm run check` — PASS. Full `npm test` — **1727 PASS, 0 FAIL, 4 SKIP** (1731 tests).
- Read against the operator's real configuration: `resolvePiCommand` returns `{command: 'pi', source: 'config'}` — the running installation keeps exactly the Pi it uses today.

KMP clients ignore unknown JSON keys (`ignoreUnknownKeys = true`), so the two added fields do not break decoding.

## Not done

- No Pi runtime is bundled yet; licences, the exact pinned version and the npm dependency closure of Pi remain a packaging task.
- Pi's own authentication/model readiness is still reported elsewhere; `state` describes only presence/compatibility of the binary.
- No live session was started against a bundled Pi, and the GUI was not restarted.
