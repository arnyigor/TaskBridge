import { CloudError } from './errors.mjs';
import { verifyMachineSecret, verifySignature } from '../../src/cloud/machine-auth.mjs';

// Cloud authentication (§64–§66). Single-user by default, multi-user if a user
// list is configured. Machine credentials are always scoped: a machine may only
// read its own commands, upload its own events and heartbeat as itself.

function parseJsonList(value, fallback = []) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function loadAuthConfig(env = process.env) {
  const users = parseJsonList(env.TASKBRIDGE_CLOUD_USERS);
  if (env.TASKBRIDGE_CLOUD_USER_TOKEN) {
    users.push({
      id: env.TASKBRIDGE_CLOUD_USER_ID || 'owner',
      email: env.TASKBRIDGE_CLOUD_USER_EMAIL || null,
      token: env.TASKBRIDGE_CLOUD_USER_TOKEN
    });
  }
  const machines = parseJsonList(env.TASKBRIDGE_CLOUD_MACHINES).map(machine => ({
    id: machine.id,
    secret: machine.secret,
    displayName: machine.displayName ?? null,
    ownerId: machine.ownerId || users[0]?.id || 'owner',
    authMode: machine.authMode || 'bearer'
  }));
  return { users, machines };
}

function bearer(headers) {
  const value = headers?.authorization || headers?.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(value).trim());
  return match ? match[1].trim() : null;
}

export class RateLimiter {
  constructor({ windowMs = 60000, max = 600, now = () => Date.now() } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.now = now;
    this.buckets = new Map();
  }

  check(key) {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.start >= this.windowMs) {
      this.buckets.set(key, { start: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.max;
  }

  reset() { this.buckets.clear(); }
}

export class CloudAuth {
  constructor({ users = [], machines = [], rateLimiter = new RateLimiter(), now = () => Date.now() } = {}) {
    this.users = users.filter(user => user?.token);
    this.machines = new Map(machines.filter(machine => machine?.id && machine?.secret).map(machine => [machine.id, machine]));
    this.rateLimiter = rateLimiter;
    this.now = now;
  }

  get machineCount() { return this.machines.size; }

  requireUser(headers) {
    const token = bearer(headers);
    if (!token) throw new CloudError('UNAUTHORIZED', 'Missing bearer token');
    const user = this.users.find(candidate => verifyMachineSecret(candidate.token, token));
    if (!user) throw new CloudError('UNAUTHORIZED', 'Invalid token');
    if (!this.rateLimiter.check(`user:${user.id}`)) throw new CloudError('RATE_LIMITED', 'Too many requests');
    return { id: user.id, email: user.email ?? null };
  }

  requireMachine(headers, { method = 'GET', path = '/', body = '' } = {}) {
    const machineId = headers?.['x-taskbridge-machine'] || headers?.['X-TaskBridge-Machine'] || null;
    if (!machineId) throw new CloudError('UNAUTHORIZED', 'Missing X-TaskBridge-Machine header');
    const machine = this.machines.get(String(machineId));
    if (!machine) throw new CloudError('UNAUTHORIZED', 'Unknown machine');
    if (machine.authMode === 'hmac') {
      const ok = verifySignature({
        secret: machine.secret,
        method,
        path,
        body,
        timestamp: headers['x-taskbridge-timestamp'] || headers['X-TaskBridge-Timestamp'],
        signature: headers['x-taskbridge-signature'] || headers['X-TaskBridge-Signature'],
        now: this.now()
      });
      if (!ok) throw new CloudError('UNAUTHORIZED', 'Invalid machine signature');
    } else if (!verifyMachineSecret(machine.secret, bearer(headers))) {
      throw new CloudError('UNAUTHORIZED', 'Invalid machine secret');
    }
    if (!this.rateLimiter.check(`machine:${machine.id}`)) throw new CloudError('RATE_LIMITED', 'Too many requests');
    return machine;
  }

  // A machine credential must not be able to read another machine's data (§66).
  assertMachineScope(machine, machineId) {
    if (machine.id !== machineId) throw new CloudError('FORBIDDEN', 'Machine scope violation');
  }

  // A user may only see machines/tasks/events it owns (§65).
  assertUserOwns(user, resource, what = 'resource') {
    if (!resource) throw new CloudError('NOT_FOUND', `Unknown ${what}`);
    if (resource.ownerId && resource.ownerId !== user.id) throw new CloudError('FORBIDDEN', `Not allowed to access this ${what}`);
    return resource;
  }
}
