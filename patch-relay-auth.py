p = 'cloud/lib/relay.mjs'
s = open(p, encoding='utf-8').read()

def sub(old, new):
    global s
    assert old in s, 'not found: ' + repr(old[:70])
    s = s.replace(old, new, 1)

sub("""import { createEnvelope, parseEnvelope, serializeEnvelope } from '../../src/cloud/protocol.mjs';""",
"""import { createEnvelope, parseEnvelope, serializeEnvelope } from '../../src/cloud/protocol.mjs';
import { createOpenAuthenticator } from './relay-auth.mjs';""")

sub("""export function createRelay({ state = createMemoryRelayState(), logger = () => {}, limits = {} } = {}) {
  const config = { ...RELAY_DEFAULTS, ...limits };""",
"""export function createRelay({ state = createMemoryRelayState(), logger = () => {}, limits = {}, auth = null } = {}) {
  const config = { ...RELAY_DEFAULTS, ...limits };
  // Secure by default: without configured credentials the relay does not accept
  // machines or clients at all. createOpenAuthenticator() is the explicit opt-in
  // for local development and routing tests.
  const authenticator = auth || { mode: 'closed',
    async authenticateMachine() { return { ok: false, code: 'AUTH_NOT_CONFIGURED', message: 'Relay credentials are not configured' }; },
    async authenticateClient() { return { ok: false, code: 'AUTH_NOT_CONFIGURED', message: 'Relay credentials are not configured' }; } };""")

sub("""      session.role = role;
      session.machineId = frame.machineId;
      session.deviceId = typeof frame.payload?.deviceId === 'string' ? frame.payload.deviceId : null;""",
"""      const deviceId = typeof frame.payload?.deviceId === 'string' ? frame.payload.deviceId : null;
      // Authentication happens before anything is routed or remembered: a peer
      // that cannot prove who it is never reaches the room maps.
      const verdict = role === 'machine'
        ? await authenticator.authenticateMachine({ machineId: frame.machineId, credential: frame.payload?.auth })
        : await authenticator.authenticateClient({ machineId: frame.machineId, deviceId, credential: frame.payload?.auth });
      if (!verdict?.ok) {
        logger('warn', { event: 'relay_auth_rejected', role, machineId: frame.machineId, code: verdict?.code || 'AUTH_FAILED' });
        send(connection, createEnvelope({ type: 'AUTH_FAIL', machineId: frame.machineId, payload: { code: verdict?.code || 'AUTH_FAILED', message: verdict?.message || 'Authentication failed' } }));
        connection.close(1008, 'auth failed');
        return false;
      }
      session.role = role;
      session.machineId = frame.machineId;
      session.deviceId = deviceId || verdict.deviceId || null;""")

sub("""            logger('info', { event: 'client_online', machineId: frame.machineId, deviceId: session.deviceId });
      }
      send(connection, createEnvelope({ type: 'AUTH_OK', machineId: frame.machineId, payload: { role, protocolVersion: frame.v } }));""",
"""            logger('info', { event: 'client_online', machineId: frame.machineId, deviceId: session.deviceId });
      }
      send(connection, createEnvelope({ type: 'AUTH_OK', machineId: frame.machineId, payload: { role, protocolVersion: frame.v, deviceId: session.deviceId } }));""")

sub("""    attach,
    // Diagnostics only: never exposes payloads.""",
"""    attach,
    authMode: authenticator.mode,
    // Diagnostics only: never exposes payloads.""")

open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('relay: auth wired')
