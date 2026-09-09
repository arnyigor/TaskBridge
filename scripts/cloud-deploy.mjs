#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { generateCredentials, cloudEnvVars } from '../cloud/lib/credentials.mjs';
import {
  buildDeployPlan,
  classifyHealth,
  maskCommandArgs,
  mergeCloudConfig,
  nextSteps,
  parseDeployUrl,
  REQUIRED_ENV_VARS
} from '../cloud/lib/deploy.mjs';

// One-command Vercel deployment for the cloud transport (§74, §92).
//
//   npm run cloud:deploy -- --project taskbridge-cloud
//   npm run cloud:deploy -- --project taskbridge-cloud --database-url postgres://…
//   npm run cloud:deploy -- --project taskbridge-cloud --write-config
//   npm run cloud:deploy -- --project taskbridge-cloud --dry-run
//
// What it does: checks the toolchain, generates fresh credentials, links the
// project, sets the environment variables, deploys to production and verifies
// /api/health. What it does NOT do: create the database (the Vercel CLI cannot
// install a Marketplace integration non-interactively) — pass --database-url, or
// add Vercel Postgres/Neon in the dashboard and re-run with --database-env.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

const flags = new Set(process.argv.filter(value => value.startsWith('--') && !value.includes('=')));
const has = name => flags.has(`--${name}`);

const options = {
  projectName: arg('project', null),
  environment: arg('environment', 'production'),
  scope: arg('scope', null),
  token: arg('token', process.env.VERCEL_TOKEN || null),
  databaseUrl: arg('database-url', null),
  databaseEnv: arg('database-env', null),
  machineId: arg('id', null),
  machineName: arg('name', null),
  ownerId: arg('owner', 'owner'),
  userEmail: arg('user', null),
  url: arg('url', null),
  allowMemoryStore: has('allow-memory-store'),
  writeConfig: has('write-config'),
  dryRun: has('dry-run'),
  json: has('json'),
  skipVerify: has('skip-verify')
};

const log = (...args) => console.log(...args);
const warn = (...args) => console.warn(...args);
const fail = message => { console.error(`\n✖ ${message}`); process.exitCode = 1; };

// Windows can only execute the `vercel.cmd` shim through a shell, and Node warns
// when args are passed alongside shell:true, so the command line is quoted once
// and handed over as a single string. No secret ever reaches the command line:
// values go through stdin.
function quoteArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9._:=/\\@-]+$/.test(text)) return text;
  return `"${text.replace(/(["\\])/g, '\\$1')}"`;
}

function run(command, args, { input = null, cwd = ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const line = [command, ...args].map(quoteArg).join(' ');
    const child = spawn(line, { cwd, stdio: [input ? 'pipe' : 'inherit', 'pipe', 'pipe'], shell: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    if (input) child.stdin.end(input);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function step(number, total, description) {
  log(`\n[${number}/${total}] ${description}`);
}

async function readProjectLink() {
  try {
    const raw = await fs.readFile(path.join(ROOT, '.vercel', 'project.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return { projectId: parsed.projectId, orgId: parsed.orgId, projectName: parsed.projectName ?? null };
  } catch {
    return null;
  }
}

async function listEnvNames() {
  const result = await run('vercel', ['env', 'ls', options.environment, '--token', options.token ?? ''].filter(Boolean));
  const names = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    const name = line.trim().split(/\s{2,}/)[0];
    if (name && /^[A-Z][A-Z0-9_]*$/.test(name)) names.add(name);
  }
  return { names, raw: result.stdout, ok: result.code === 0 };
}

async function writeLocalConfig(patch) {
  const configPath = path.join(ROOT, 'config.json');
  let existing = {};
  try {
    existing = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const backup = `${configPath}.bak-${Date.now()}`;
    await fs.writeFile(backup, JSON.stringify(existing, null, 2), 'utf8');
    log(`    backup: ${path.relative(ROOT, backup)}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try {
      existing = JSON.parse(await fs.readFile(path.join(ROOT, 'config.example.json'), 'utf8'));
    } catch { existing = {}; }
  }
  const merged = mergeCloudConfig(existing, patch);
  await fs.writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  log(`    written: ${path.relative(ROOT, configPath)} (cloud.url = ${patch.cloud.url})`);
}

async function main() {
  log('TaskBridge cloud → Vercel\n─────────────────────────');

  // 0. Toolchain ------------------------------------------------------------
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeMinor = Number(process.versions.node.split('.')[1]);
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
    return fail(`Node >= 22.13 is required (running ${process.versions.node}).`);
  }

  const vercelVersion = await run('vercel', ['--version']);
  if (vercelVersion.code !== 0) {
    return fail('Vercel CLI not found. Install it with: npm install -g vercel');
  }
  log(`    node ${process.versions.node}, ${vercelVersion.stdout.trim()}`);

  if (!options.dryRun) {
    const whoami = await run('vercel', ['whoami', ...(options.token ? ['--token', options.token] : [])]);
    if (whoami.code !== 0) {
      return fail(`Not logged in to Vercel. Run "vercel login" once (or pass --token).\n${whoami.stderr.trim()}`);
    }
    log(`    logged in as ${whoami.stdout.trim()}`);
  }

  // 1. Credentials ----------------------------------------------------------
  const credentials = generateCredentials({
    machineId: options.machineId || undefined,
    machineName: options.machineName || undefined,
    ownerId: options.ownerId,
    userEmail: options.userEmail
  });

  // 2. Plan -----------------------------------------------------------------
  const link = await readProjectLink();
  const plan = buildDeployPlan({
    projectName: options.projectName || link?.projectName || null,
    environment: options.environment,
    scope: options.scope,
    token: options.token,
    credentials,
    databaseUrl: options.databaseUrl,
    allowMemoryStore: options.allowMemoryStore,
    writeConfig: options.writeConfig
  });

  // A project that already carries a database does not need --database-url.
  if (!options.databaseUrl && options.databaseEnv && !options.dryRun) {
    const { names } = await listEnvNames();
    if (!names.has(options.databaseEnv)) {
      return fail(`${options.databaseEnv} is not set on project "${plan.steps[0]?.args.at(-1) ?? '?'}". Add the database first or pass --database-url.`);
    }
    log(`    using existing ${options.databaseEnv} from the project`);
  }

  if (options.dryRun) {
    for (const warning of plan.warnings) warn(`! ${warning}`);
    for (const blocker of plan.blockers) warn(`✖ would refuse to deploy: ${blocker}`);
    log('\nDry run — commands that would run:');
    for (const item of plan.steps) log(`  vercel ${maskCommandArgs(item.args).join(' ')}${item.stdin ? '   (value via stdin)' : ''}`);
    log('\nRe-run without --dry-run to execute.');
    if (plan.blockers.length) process.exitCode = 1;
    return;
  }

  if (plan.blockers.length) {
    for (const blocker of plan.blockers) warn(`✖ ${blocker}`);
    return fail('Refusing to deploy.');
  }
  for (const warning of plan.warnings) warn(`! ${warning}`);

  log(`\n    machine id:    ${credentials.machineId} (${credentials.machineName})`);
  log(`    user token:    ${credentials.userToken.slice(0, 12)}… (printed in full at the end)`);
  log(`    env vars:      ${Object.keys(plan.envVars).join(', ')}`);

  // 3. Execute --------------------------------------------------------------
  const total = plan.steps.length;
  let deployedUrl = null;

  for (let index = 0; index < plan.steps.length; index++) {
    const item = plan.steps[index];
    step(index + 1, total, item.description);
    const result = await run('vercel', item.args, { input: item.stdin ?? null });
    if (result.code !== 0) {
      return fail(`"vercel ${item.args.slice(0, 3).join(' ')}" failed (exit ${result.code}).\n${(result.stderr || result.stdout).trim().split('\n').slice(-8).join('\n')}`);
    }
    if (item.id === 'deploy') {
      deployedUrl = parseDeployUrl(result.stdout) ?? parseDeployUrl(result.stderr);
      log(`    ${deployedUrl ?? result.stdout.trim().split('\n').slice(-1)[0]}`);
    } else {
      log('    ok');
    }
  }

  const url = (options.url || deployedUrl || '').replace(/\/$/, '');
  if (!url) return fail('Deployment succeeded but no URL could be parsed; check `vercel ls`.');

  // 4. Verify ---------------------------------------------------------------
  let health = null;
  if (!options.skipVerify) {
    step(total + 1, total + 1, `Verifying ${url}/api/health`);
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        const response = await fetch(`${url}/api/health`, { headers: { accept: 'application/json' } });
        const body = await response.json().catch(() => null);
        health = classifyHealth(body);
        if (health.ok && health.durable) break;
      } catch (error) {
        health = { ok: false, durable: false, message: error.message };
      }
      await new Promise(resolve => setTimeout(resolve, 2500));
    }
    log(`    ${health?.message ?? 'no response'}`);
    if (!health?.ok) return fail('The deployment did not answer /api/health. Check `vercel logs`.');
    if (!health.durable) {
      warn('! The store is not durable — tasks will vanish. Add Vercel Postgres/Neon, then re-run:');
      warn('  npm run cloud:deploy -- --project <name> --database-env POSTGRES_URL --url ' + url);
    }

    // The token must actually be accepted.
    const authCheck = await fetch(`${url}/api/machines`, { headers: { authorization: `Bearer ${credentials.userToken}` } });
    log(`    token check: ${authCheck.status === 200 ? 'accepted' : `HTTP ${authCheck.status} — check TASKBRIDGE_CLOUD_USER_TOKEN`}`);
  }

  // 5. Local config ---------------------------------------------------------
  if (options.writeConfig) {
    step(total + 2, total + 2, 'Writing config.json');
    await writeLocalConfig({ cloud: { ...credentials.cloudConfig, url } });
  }

  const steps = nextSteps({ url, userToken: credentials.userToken, machineId: credentials.machineId });
  log('\n─────────────────────────');
  log(`Deployed: ${url}`);
  log(`Health:   ${health ? health.message : 'not verified'}\n`);
  for (const line of steps) log(line);
  if (!options.writeConfig) {
    log('\nLocal config block for config.json:');
    log(JSON.stringify({ cloud: { ...credentials.cloudConfig, url } }, null, 2));
  }
  log('\nKeep the machine secret out of git; rotate by re-running this script.');

  if (options.json) {
    log(`\n${JSON.stringify({ url, health, machineId: credentials.machineId, env: cloudEnvVars(credentials), required: REQUIRED_ENV_VARS }, null, 2)}`);
  }
}

main().catch(error => fail(error.stack ?? String(error)));
