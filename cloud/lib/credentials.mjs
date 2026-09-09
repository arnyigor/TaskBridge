import crypto from 'node:crypto';
import os from 'node:os';

// Single source of truth for cloud credentials (§11, §90), used by
// `npm run cloud:secrets` and `npm run cloud:deploy` so the two can never
// generate incompatible material.

export function randomToken(prefix) {
  return `${prefix}${crypto.randomBytes(32).toString('base64url')}`;
}

export function defaultMachineId() {
  return `home-pc-${crypto.randomBytes(2).toString('hex')}`;
}

export function defaultMachineName() {
  const host = os.hostname().replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 40);
  return host || 'TaskBridge workstation';
}

export function generateCredentials({
  machineId = defaultMachineId(),
  machineName = defaultMachineName(),
  ownerId = 'owner',
  userEmail = null
} = {}) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(machineId)) {
    throw new Error(`Invalid machine id "${machineId}": use letters, digits, dot, dash or underscore (max 64).`);
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(ownerId)) {
    throw new Error(`Invalid owner id "${ownerId}".`);
  }
  const userToken = randomToken('tb_user_');
  const machineSecret = randomToken('tb_machine_');
  return {
    userToken,
    ownerId,
    userEmail,
    machineId,
    machineName,
    machineSecret,
    // Exactly what TASKBRIDGE_CLOUD_MACHINES expects.
    machinesJson: JSON.stringify([{ id: machineId, secret: machineSecret, ownerId, displayName: machineName }]),
    cloudConfig: {
      enabled: true,
      url: null,
      machineId,
      machineSecret,
      machineDisplayName: machineName
    }
  };
}

// The env vars the cloud function needs. `url` is intentionally absent: it is a
// local setting, not a cloud one.
export function cloudEnvVars(credentials, { databaseUrl = null } = {}) {
  const vars = {
    TASKBRIDGE_CLOUD_USER_TOKEN: credentials.userToken,
    TASKBRIDGE_CLOUD_USER_ID: credentials.ownerId,
    TASKBRIDGE_CLOUD_MACHINES: credentials.machinesJson
  };
  if (credentials.userEmail) vars.TASKBRIDGE_CLOUD_USER_EMAIL = credentials.userEmail;
  if (databaseUrl) vars.POSTGRES_URL = databaseUrl;
  return vars;
}
