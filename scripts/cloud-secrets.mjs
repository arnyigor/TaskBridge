import crypto from 'node:crypto';
import os from 'node:os';

// Generates the credentials a TaskBridge cloud deployment needs (§11, §90) and
// prints them ready to paste. Nothing is written anywhere: you decide where the
// secret lives.
//
//   npm run cloud:secrets                  # machine id + secrets
//   npm run cloud:secrets -- --url https://taskbridge.example.app
//   npm run cloud:secrets -- --user me@example.com
//   npm run cloud:secrets -- --json        # machine-readable

import { generateCredentials, cloudEnvVars } from '../cloud/lib/credentials.mjs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

const url = arg('url', 'https://<your-project>.vercel.app');
const userEmail = arg('user', null);
const machineName = arg('name', null);
const machineId = arg('id', null);
const ownerId = arg('owner', 'owner');

const credentials = generateCredentials({
  machineId: machineId || undefined,
  machineName: machineName || undefined,
  ownerId,
  userEmail
});

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    ...credentials,
    cloudConfig: { ...credentials.cloudConfig, url: url === 'https://<your-project>.vercel.app' ? null : url },
    env: cloudEnvVars(credentials)
  }, null, 2));
  process.exit(0);
}

console.log(`# Generated ${new Date().toISOString()} on ${os.hostname()}\n`);
console.log('# 1. Vercel → Project → Settings → Environment Variables');
for (const [name, value] of Object.entries(cloudEnvVars(credentials))) console.log(`${name}=${value}`);
console.log('POSTGRES_URL=<from Vercel Postgres / Neon, or TASKBRIDGE_CLOUD_STORE=postgres://...>\n');

console.log('# 2. This machine — config.json "cloud" block (or the same names as env vars)');
console.log(JSON.stringify({ cloud: { ...credentials.cloudConfig, url } }, null, 2));
console.log('\n# 3. What you paste into the PWA "Access token" field:');
console.log(credentials.userToken);
console.log('\n# Rotate by re-running this script: change the secret in both places, then restart TaskBridge.');
console.log('# Faster: npm run cloud:deploy -- --project <name>  (generates, sets Vercel env, deploys, verifies)');
console.log(`# Machine secret fingerprint: ${crypto.createHash('sha256').update(credentials.machineSecret).digest('hex').slice(0, 12)}`);
