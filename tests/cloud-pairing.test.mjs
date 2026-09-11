import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFixture } from './server-fixture.mjs';
import { TrustedDevices, newDeviceId } from '../src/cloud/trusted-devices.mjs';
import { verifyDeviceToken, issueDeviceToken } from '../src/cloud/device-token.mjs';
import { createRelayServer } from '../cloud/lib/relay-server.mjs';
import { createSecretAuthenticator } from '../cloud/lib/relay-auth.mjs';
import { createRelayConnector } from '../src/cloud/relay-connector.mjs';
import { createCloudTransport } from '../web/transport.mjs';

// Pairing a phone (§ pairing): the machine mints the credential, remembers the
// device, and is the only place that can take the access back — a device token
// is a stateless signature the relay is unable to revoke.

const SECRET = 'machine-secret-0123456789';

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-devices-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('the device list survives a restart and only a live device is allowed', async t => {
  const root = await tempRoot(t);
  const devices = await new TrustedDevices(root).load();
  const id = newDeviceId();
  await devices.add({ deviceId: id, name: 'Телефон', machineId: 'home-pc' });

  assert.equal(devices.allowed(id), true);
  assert.equal(devices.allowed('dev-unknown'), false, 'an unknown device is not trusted by default');

  await devices.revoke(id);
  assert.equal(devices.allowed(id), false, 'a revoked device loses access immediately');
  assert.equal(devices.list()[0].revokedAt !== null, true, 'and stays visible as revoked');

  // A restart must not hand the access back.
  const reloaded = await new TrustedDevices(root).load();
  assert.equal(reloaded.allowed(id), false);
  assert.equal(reloaded.list().length, 1);

  await reloaded.remove(id);
  assert.deepEqual((await new TrustedDevices(root).load()).list(), [], 'forgetting a device really removes it');
  await assert.rejects(() => reloaded.remove(id), /не найдено/);
});

test('a damaged trusted-devices.json means "nobody is paired", not a crash', async t => {
  const root = await tempRoot(t);
  await fs.writeFile(path.join(root, 'trusted-devices.json'), '{ this is not json', 'utf8');
  const devices = await new TrustedDevices(root).load();
  assert.deepEqual(devices.list(), []);
  assert.equal(devices.allowed('dev-any'), false);
  // And pairing still works afterwards, rewriting the file.
  const id = newDeviceId();
  await devices.add({ deviceId: id, name: 'Новый' });
  assert.equal((await new TrustedDevices(root).load()).allowed(id), true);
});

test('HTTP: the machine mints a QR link, lists the device and revokes it', { timeout: 40000 }, async t => {
  const fixture = await startFixture(0, {
    root: { cloud: { enabled: true, url: 'https://taskbridge.example.app', machineId: 'home-pc', machineSecret: SECRET } }
  });
  t.after(() => fixture.close());

  assert.deepEqual((await fixture.api('/api/cloud/devices')).devices, [], 'no phone is trusted out of the box');

  const pairing = await fixture.api('/api/cloud/pair', { name: 'Телефон Арни' });
  const link = new URL(pairing.url);
  assert.equal(link.origin + link.pathname, 'https://taskbridge.example.app/pair');
  assert.equal(link.search, '', 'the credential must never be a query parameter — servers log those');

  const params = new URLSearchParams(link.hash.slice(1));
  assert.equal(params.get('m'), 'home-pc');
  assert.equal(params.get('r'), 'wss://taskbridge.example.app/api/relay');
  const verdict = verifyDeviceToken(params.get('t'), { secret: SECRET, machineId: 'home-pc' });
  assert.equal(verdict.ok, true, `the QR token must verify against the machine secret: ${verdict.reason}`);
  assert.equal(verdict.deviceId, pairing.device.deviceId);

  const listed = await fixture.api('/api/cloud/devices');
  assert.equal(listed.devices.length, 1);
  assert.equal(listed.devices[0].name, 'Телефон Арни');
  assert.equal(listed.devices[0].revokedAt, null);
  assert.equal(JSON.stringify(listed).includes(params.get('t')), false, 'the token is shown once, in the QR, and never again');

  const revoked = await fixture.api(`/api/cloud/devices/${listed.devices[0].deviceId}`, {});
  assert.ok(revoked.device.revokedAt, 'revoking marks the device');
  assert.ok((await fixture.api('/api/cloud/devices')).devices[0].revokedAt, 'and it stays revoked in the list');

  // The record survives a restart of the machine, which is the point of the file.
  await fixture.restart();
  const afterRestart = await fixture.api('/api/cloud/devices');
  assert.equal(afterRestart.devices.length, 1);
  assert.ok(afterRestart.devices[0].revokedAt);

  await fixture.api(`/api/cloud/devices/${afterRestart.devices[0].deviceId}`, undefined, 'DELETE');
  assert.deepEqual((await fixture.api('/api/cloud/devices')).devices, []);
});

test('HTTP: pairing is refused while the cloud has no address or secret', { timeout: 40000 }, async t => {
  const fixture = await startFixture(0);
  t.after(() => fixture.close());
  await assert.rejects(() => fixture.api('/api/cloud/pair', {}), error => {
    assert.match(error.message, /настройте облако/i);
    assert.equal(error.status, 400);
    return true;
  });
});

test('a revoked device is refused by the machine itself, over a real relay', { timeout: 40000 }, async t => {
  const machineId = 'home-pc';
  const root = await tempRoot(t);
  const devices = await new TrustedDevices(root).load();
  const goodId = newDeviceId();
  const badId = newDeviceId();
  await devices.add({ deviceId: goodId, name: 'Живой' });
  await devices.add({ deviceId: badId, name: 'Отозванный' });
  await devices.revoke(badId);

  const relay = createRelayServer({
    auth: createSecretAuthenticator({ machines: [{ id: machineId, secret: SECRET }] }),
    logger: () => {}
  });
  const endpoint = await relay.listen({ port: 0 });
  t.after(() => endpoint.close());

  const executed = [];
  const connector = createRelayConnector({
    url: endpoint.url,
    machineId,
    machineSecret: SECRET,
    manager: { on() {}, off() {}, listTasks: () => [] },
    dispatcher: { async handle(command) { executed.push(command); return { status: 'ACCEPTED', detail: { ok: true } }; } },
    store: { async readEvents() { return []; } },
    isDeviceAllowed: (deviceId) => Boolean(deviceId) && devices.allowed(deviceId),
    logger: () => {}
  });
  t.after(() => connector.stop());
  await connector.start();

  const connect = async (deviceId) => {
    const transport = createCloudTransport({
      url: endpoint.url,
      machineId,
      deviceToken: issueDeviceToken({ machineId, deviceId, secret: SECRET }),
      logger: () => {}
    });
    t.after(() => transport.close());
    await transport.ready();
    return transport;
  };

  // The paired phone is served as before.
  const live = await connect(goodId);
  const accepted = await live.command({ sessionId: 'tb_1', type: 'STOP', data: {}, timeoutMs: 5000 });
  assert.equal(accepted.status, 'ACCEPTED');
  assert.equal(executed.length, 1, 'the command actually reached the dispatcher');

  // The revoked one still has a signature the relay accepts — and is stopped
  // here, by the machine, with an honest reason instead of silence.
  const revoked = await connect(badId);
  await assert.rejects(
    () => revoked.command({ sessionId: 'tb_1', type: 'STOP', data: {}, timeoutMs: 5000 }),
    error => {
      assert.match(`${error.code} ${error.message}`, /DEVICE_REVOKED|отключено/i);
      return true;
    }
  );
  assert.equal(executed.length, 1, 'nothing a revoked device asked for was executed');
});
