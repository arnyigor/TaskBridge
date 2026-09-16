import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { AccessControl } from '../src/auth.mjs';

// `machine()` decides whether a request came from the computer itself — the gate
// for opening a file with an OS application. It must say yes for the PC (even
// when it reaches the app through the LAN proxy from its own LAN address) and no
// for a phone on the same network.
const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
const access = () => new AccessControl({}, os.tmpdir()); // auth off: no files involved

test('machine() accepts loopback and this host, rejects everybody else', () => {
  const a = access();
  assert.equal(a.machine(req('127.0.0.1')), true, 'loopback IPv4');
  assert.equal(a.machine(req('::1')), true, 'loopback IPv6');
  assert.equal(a.machine(req('::ffff:127.0.0.1')), true, 'IPv4-mapped loopback');
  assert.equal(a.machine(req('203.0.113.9')), false, 'a remote address is not this machine');

  // A LAN address this host actually owns counts as the machine; a phone's does not.
  const own = Object.values(os.networkInterfaces()).flat().map(i => i && i.address).find(address => address && !/^127\.|^::1$/.test(address));
  if (own) assert.equal(a.machine(req(own)), true, `own address ${own}`);
  assert.equal(a.machine(req('198.51.100.7')), false, 'an address this host does not own');
});

test('machine() trusts only the last X-Forwarded-For entry from a loopback proxy', () => {
  const a = access();
  // Browser on the PC using the machine's LAN address: the proxy forwards it.
  assert.equal(a.machine(req('127.0.0.1', { 'x-forwarded-for': '192.168.1.212' })), true);
  // A phone: the proxy appended the phone's address.
  assert.equal(a.machine(req('127.0.0.1', { 'x-forwarded-for': '192.168.1.50' })), false);
  // A client may prepend its own value; the entry our proxy appended is last and
  // is the one we trust, so a spoofed "I am the PC" cannot get in.
  assert.equal(a.machine(req('127.0.0.1', { 'x-forwarded-for': '192.168.1.212, 192.168.1.50' })), false);
  assert.equal(a.machine(req('127.0.0.1', { 'x-forwarded-for': '192.168.1.50, 127.0.0.1' })), true);
});

test('the Host-based local() rule is unchanged (the pairing code still needs it)', () => {
  const a = access();
  assert.equal(a.local(req('127.0.0.1', { host: 'localhost:8787' })), true);
  assert.equal(a.local(req('127.0.0.1', { host: '192.168.1.212:8787' })), false);
});
