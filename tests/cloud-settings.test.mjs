import test from 'node:test';
import assert from 'node:test';
import assertStrict from 'node:assert/strict';
import { startFixture } from './server-fixture.mjs';
import { startServer } from '../cloud/server.mjs';

// The local settings screen (§91): read masked config, validate before saving,
// apply live, and test a connection without persisting anything.

const USER_TOKEN = 'settings-user-token-123456';
const MACHINE = { id: 'settings-machine', secret: 'settings-machine-secret-123456', ownerId: 'owner', displayName: 'Settings Workstation' };

async function waitFor(check, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

async function withCloud(action) {
  const server = await startServer({
    port: 0,
    host: '127.0.0.1',
    storeTarget: 'memory:',
    env: { TASKBRIDGE_CLOUD_USER_TOKEN: USER_TOKEN, TASKBRIDGE_CLOUD_MACHINES: JSON.stringify([MACHINE]) },
    logger: () => {}
  });
  const user = async (route) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${route}`, { headers: { authorization: `Bearer ${USER_TOKEN}` } });
    return { status: response.status, body: await response.json() };
  };
  try { return await action({ server, user }); }
  finally { await server.close(); }
}

test('cloud settings API masks the secret, validates before saving and applies live', { timeout: 40000 }, async t => {
  await withCloud(async ({ server, user }) => {
    const fixture = await startFixture();
    t.after(() => fixture.close());
    const { api } = fixture;

    const initial = await api('/api/cloud/config');
    assertStrict.equal(initial.enabled, false);
    assertStrict.equal(initial.hasSecret, false);
    assertStrict.equal(initial.secretFingerprint, null);

    // An invalid candidate is rejected and not persisted.
    await assertStrict.rejects(api('/api/cloud/config', { enabled: true, url: 'not-a-url', machineId: 'x', machineSecret: 'short' }), { code: 'INPUT_INVALID' });
    assertStrict.equal((await api('/api/cloud/config')).enabled, false);

    // A valid candidate starts the transport immediately.
    const saved = await api('/api/cloud/config', {
      enabled: true,
      url: `http://127.0.0.1:${server.port}`,
      machineId: MACHINE.id,
      machineDisplayName: MACHINE.displayName,
      machineSecret: MACHINE.secret,
      redactPaths: true
    });
    assertStrict.equal(saved.ok, true);
    assertStrict.equal(saved.enabled, true);

    const machine = await waitFor(async () => (await user('/api/machines')).body.find(item => item.id === MACHINE.id && item.status === 'ONLINE'));
    assertStrict.equal(machine.displayName, MACHINE.displayName);

    const reloaded = await api('/api/cloud/config');
    assertStrict.equal(reloaded.enabled, true);
    assertStrict.equal(reloaded.hasSecret, true);
    assertStrict.match(reloaded.secretFingerprint, /^[0-9a-f]{12}$/);
    assertStrict.equal(reloaded.machineId, MACHINE.id);
    assertStrict.equal(JSON.stringify(reloaded).includes(MACHINE.secret), false, 'the API never returns the secret');

    const status = await api('/debug/cloud');
    assertStrict.equal(status.enabled, true);
    assertStrict.equal(status.machineId, MACHINE.id);

    // Turning it off stops the worker but keeps the saved settings.
    const disabled = await api('/api/cloud/config', { enabled: false });
    assertStrict.equal(disabled.enabled, false);
    assertStrict.equal((await api('/debug/cloud')).enabled, false);
  });
});

test('cloud settings test endpoint reports success and failures without saving', { timeout: 30000 }, async t => {
  await withCloud(async ({ server }) => {
    const fixture = await startFixture();
    t.after(() => fixture.close());
    const { api } = fixture;

    const bad = await api('/api/cloud/test', { url: 'not-a-url', machineId: 'x', machineSecret: 'y'.repeat(20) });
    assertStrict.equal(bad.ok, false);
    assertStrict.match(bad.problems.join(' '), /TASKBRIDGE_CLOUD_URL/);

    const wrongSecret = await api('/api/cloud/test', {
      url: `http://127.0.0.1:${server.port}`, machineId: MACHINE.id, machineSecret: 'wrong-secret-1234567890'
    });
    assertStrict.equal(wrongSecret.ok, false);
    assertStrict.equal(wrongSecret.error.code, 'UNAUTHORIZED');

    const ok = await api('/api/cloud/test', {
      url: `http://127.0.0.1:${server.port}`, machineId: MACHINE.id, machineSecret: MACHINE.secret
    });
    assertStrict.equal(ok.ok, true);
    assertStrict.equal(ok.machineId, MACHINE.id);

    // Testing never persists anything.
    assertStrict.equal((await api('/api/cloud/config')).enabled, false);
  });
});
