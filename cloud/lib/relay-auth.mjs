import crypto from 'node:crypto';
import { verifyDeviceToken } from '../../src/cloud/device-token.mjs';

// Who may connect to the relay (§ cloud-protocol.md).
//
// The relay accepts a machine only with its secret, and a client only with a
// device token that machine signed — so knowing a machineId is not enough to
// watch someone's session. Trusted devices stay on the PC; the relay needs no
// registry of its own, only the machine secrets of *this* deployment.

const deny = (code, message) => ({ ok: false, code, message });

/**
 * Explicitly unauthenticated relay: local development and routing tests only.
 * A production deployment must configure secrets — see createSecretAuthenticator.
 */
export function createOpenAuthenticator() {
  return {
    mode: 'open',
    async authenticateMachine() { return { ok: true }; },
    async authenticateClient() { return { ok: true }; }
  };
}

/**
 * Secure-by-default authenticator.
 *
 * @param machines [{ id, secret, displayName? }] — the machines this relay serves.
 * A client must present payload.auth.deviceToken; the machine must present
 * payload.auth.secret.
 */
export function createSecretAuthenticator({ machines = [], logger = () => {} } = {}) {
  const byId = new Map();
  for (const machine of machines) {
    if (!machine?.id || typeof machine.secret !== 'string') continue;
    byId.set(machine.id, machine);
  }

  return {
    mode: 'secret',
    async authenticateMachine({ machineId, credential } = {}) {
      const machine = byId.get(machineId);
      if (!machine) return deny('MACHINE_UNKNOWN', `Machine ${machineId} is not configured on this relay`);
      const secret = credential?.secret;
      if (typeof secret !== 'string' || !secret) return deny('MACHINE_SECRET_REQUIRED', 'HELLO needs payload.auth.secret');
      const given = Buffer.from(secret);
      const expected = Buffer.from(machine.secret);
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        logger('warn', { event: 'relay_auth_failed', role: 'machine', machineId });
        return deny('MACHINE_SECRET_INVALID', 'machine secret does not match');
      }
      return { ok: true, machineId };
    },
    async authenticateClient({ machineId, deviceId, credential } = {}) {
      const machine = byId.get(machineId);
      if (!machine) return deny('MACHINE_UNKNOWN', `Machine ${machineId} is not configured on this relay`);
      const result = verifyDeviceToken(credential?.deviceToken, { secret: machine.secret, machineId, deviceId });
      if (!result.ok) {
        logger('warn', { event: 'relay_auth_failed', role: 'client', machineId, reason: result.reason });
        return deny(result.reason, result.message);
      }
      return { ok: true, machineId, deviceId: result.deviceId, expiresAt: result.expiresAt };
    }
  };
}
