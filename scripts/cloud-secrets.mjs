import crypto from 'node:crypto';
import os from 'node:os';

// Generates the credentials a TaskBridge cloud deployment needs (§11, §90) and
// prints them ready to paste. Nothing is written anywhere: you decide where the
// secret lives.
//
//   npm run cloud:secrets                  # machine id + secrets
//   npm run cloud:secrets -- --url https://taskbridge.example.app
//   npm run cloud:secrets -- --user me@example.com

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

const url = arg('url', 'https://taskbridge.example.app');
const userEmail = arg('user', null);
const machineId = arg('id', `home-pc-${crypto.randomBytes(2).toString('hex')}`);
const machineName = arg('name', os.hostname().replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 40) || 'TaskBridge workstation');

const userToken = `tb_user_${crypto.randomBytes(32).toString('base64url')}`;
const machineSecret = `tb_machine_${crypto.randomBytes(32).toString('base64url')}`;
const ownerId = arg('owner', 'owner');

console.log(`# Generated ${new Date().toISOString()}\n`);
console.log('# 1. Vercel → Project → Settings → Environment Variables');
console.log(`TASKBRIDGE_CLOUD_USER_TOKEN=${userToken}`);
console.log(`TASKBRIDGE_CLOUD_USER_ID=${ownerId}${userEmail ? `\nTASKBRIDGE_CLOUD_USER_EMAIL=${userEmail}` : ''}`);
console.log(`TASKBRIDGE_CLOUD_MACHINES=${JSON.stringify([{ id: machineId, secret: machineSecret, ownerId, displayName: machineName }])}`);
console.log('POSTGRES_URL=<from Vercel Postgres / Neon, or set TASKBRIDGE_CLOUD_STORE=postgres://...>\n');

console.log('# 2. This machine — config.json "cloud" block (or the same names as env vars)');
console.log(JSON.stringify({
  cloud: {
    enabled: true,
    url,
    machineId,
    machineSecret,
    machineDisplayName: machineName
  }
}, null, 2));
console.log('\n# 3. What you paste into the PWA "Access token" field:');
console.log(userToken);
console.log('\n# Rotate by re-running this script: change the secret in both places, then restart TaskBridge.');
