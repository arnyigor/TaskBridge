// Pure helpers behind `npm run cloud:deploy`. Everything that decides *what* to
// run is here and unit-tested; scripts/cloud-deploy.mjs only executes it.
//
// Keeping the plan separate is deliberate: the deploy script touches a live
// Vercel account, so the risky part must be reviewable without running it.

export const REQUIRED_ENV_VARS = ['TASKBRIDGE_CLOUD_USER_TOKEN', 'TASKBRIDGE_CLOUD_USER_ID', 'TASKBRIDGE_CLOUD_MACHINES'];

// `vercel deploy` uploads the working directory and does not read .gitignore, so
// these paths must be excluded explicitly or a machine secret / task database
// would end up inside a deployment.
export const REQUIRED_IGNORES = ['config.json', 'data/', 'cloud/data/'];

export function verifyVercelIgnore(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
  const missing = REQUIRED_IGNORES.filter(entry => !lines.includes(entry));
  return { ok: missing.length === 0, missing, lines };
}

// Vars that must exist for the store to survive a serverless invocation.
export const DURABILITY_ENV_VARS = ['POSTGRES_URL', 'DATABASE_URL', 'POSTGRES_PRISMA_URL', 'TASKBRIDGE_CLOUD_STORE'];

export function maskSecret(value) {
  const text = String(value ?? '');
  if (text.length <= 10) return '***';
  return `${text.slice(0, 8)}…${text.slice(-4)} (${text.length} chars)`;
}

export function maskCommandArgs(args) {
  // Never print a secret into a shell history or a CI log.
  return args.map(arg => (/^tb_(user|machine)_/.test(arg) || /^postgres(ql)?:\/\//.test(arg) ? maskSecret(arg) : arg));
}

export function vercelArgs(base, { scope = null, token = null } = {}) {
  const args = [...base];
  if (scope) args.push('--scope', scope);
  if (token) args.push('--token', token);
  return args;
}

export function buildEnvVarCommands(vars, { environment = 'production', scope = null, token = null } = {}) {
  return Object.entries(vars).map(([name, value]) => ({
    name,
    args: vercelArgs(['env', 'add', name, environment, '--force'], { scope, token }),
    stdin: `${value}\n`
  }));
}

export function buildDeployPlan({
  projectName = null,
  environment = 'production',
  scope = null,
  token = null,
  credentials = null,
  databaseUrl = null,
  allowMemoryStore = false,
  writeConfig = false
} = {}) {
  const blockers = [];
  const warnings = [];

  if (!projectName) blockers.push('Missing --project <name> (the Vercel project to create or reuse).');
  if (!credentials) blockers.push('Missing credentials; the script generates them itself, so this is a bug.');

  const vars = credentials
    ? {
        ...(credentials.userEmail ? { TASKBRIDGE_CLOUD_USER_EMAIL: credentials.userEmail } : {}),
        TASKBRIDGE_CLOUD_USER_TOKEN: credentials.userToken,
        TASKBRIDGE_CLOUD_USER_ID: credentials.ownerId,
        TASKBRIDGE_CLOUD_MACHINES: credentials.machinesJson,
        ...(databaseUrl ? { POSTGRES_URL: databaseUrl } : {})
      }
    : {};

  if (!databaseUrl && !allowMemoryStore) {
    blockers.push(
      'No Postgres URL. Pass --database-url postgres://… (or --database-env POSTGRES_URL if the project already has one). '
      + 'Without a durable store every task is lost between invocations; pass --allow-memory-store only for a throwaway demo.'
    );
  } else if (!databaseUrl) {
    warnings.push('Deploying with an in-memory store: tasks will not survive the next invocation.');
  }

  const steps = [];
  if (projectName) {
    steps.push({ id: 'link', description: `Link this directory to Vercel project "${projectName}"`, args: vercelArgs(['link', '--yes', '--project', projectName], { scope, token }) });
  }
  for (const command of buildEnvVarCommands(vars, { environment, scope, token })) {
    steps.push({ id: `env:${command.name}`, description: `Set ${command.name} (${environment})`, args: command.args, stdin: command.stdin, secret: true });
  }
  steps.push({ id: 'deploy', description: 'Deploy to production', args: vercelArgs(['deploy', '--prod', '--yes'], { scope, token }) });

  return { steps, blockers, warnings, envVars: vars, writeConfig };
}

export function parseDeployUrl(output) {
  const text = String(output ?? '');
  const urls = text.match(/https:\/\/[A-Za-z0-9._-]+\.vercel\.app/g);
  if (!urls?.length) return null;
  // The last production URL printed is the deployment that just finished.
  return urls[urls.length - 1];
}

export function classifyHealth(body) {
  if (!body || typeof body !== 'object') return { ok: false, durable: false, message: 'Empty or invalid /api/health response.' };
  if (body.status !== 'ok') return { ok: false, durable: false, message: `Health reports status "${body.status}".` };
  const store = body.store ?? 'unknown';
  const durable = body.durable === true || (body.durable === undefined && store !== 'memory' && store !== 'unknown');
  return {
    ok: true,
    durable,
    store,
    message: durable
      ? `ok — store: ${store}`
      : `ok, but store: ${store} is NOT durable (set POSTGRES_URL and redeploy)`
  };
}

export function buildLocalConfigPatch(credentials, url) {
  return {
    cloud: {
      enabled: true,
      url,
      machineId: credentials.machineId,
      machineSecret: credentials.machineSecret,
      machineDisplayName: credentials.machineName
    }
  };
}

export function mergeCloudConfig(existing, patch) {
  const config = existing && typeof existing === 'object' ? { ...existing } : {};
  config.cloud = { ...(config.cloud ?? {}), ...patch.cloud };
  return config;
}

// What the operator should do next, printed at the end of a successful run.
export function nextSteps({ url, userToken, machineId, pwaReady = true }) {
  return [
    pwaReady ? `1. Open ${url} on your phone, paste the access token below, then "Add to Home Screen".` : `1. Open ${url} once the deployment is ready.`,
    '2. Paste this access token into the PWA (it is not stored anywhere on the server side):',
    `   ${userToken}`,
    `3. Point this machine at the cloud: run \`npm run cloud:deploy -- --write-config\` once, or add the "cloud" block to config.json (machine ${machineId}), then restart TaskBridge.`,
    '4. Check http://127.0.0.1:8787/debug/cloud → "connected": true.',
    '5. Create a task from the phone and watch it run locally.'
  ];
}
