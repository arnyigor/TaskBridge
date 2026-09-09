import { openStore, resolveStoreTarget } from '../lib/store.mjs';
import { CloudAuth, loadAuthConfig } from '../lib/auth.mjs';
import { createRouter } from '../lib/router.mjs';
import { errorBody } from '../lib/errors.mjs';

// Vercel serverless entry point (re-exported by the root api/index.mjs). It only
// adapts the request/response shape and delegates to the shared router, so a
// deployment cannot drift from the tested API contract (§74, §92).
//
// Required environment variables:
//   TASKBRIDGE_CLOUD_STORE    sqlite:/var/task/data/cloud.db is NOT durable on
//                             Vercel — use a persistent store target instead.
//   TASKBRIDGE_CLOUD_USER_TOKEN / TASKBRIDGE_CLOUD_USERS
//   TASKBRIDGE_CLOUD_MACHINES JSON list of { id, secret, displayName, ownerId }
//
// NOTE: Vercel's filesystem is ephemeral, so a serverless deployment needs a
// persistent adapter. cloud/lib/store.mjs ships MemoryStore and SqliteStore;
// add a Postgres adapter implementing the same interface before deploying to
// Vercel. See docs/cloud-transport.md.

let cached = null;

async function getService() {
  if (cached) return cached;
  const storeTarget = process.env.TASKBRIDGE_CLOUD_STORE || process.env.CLOUD_STORE || resolveStoreTarget(process.env);
  const store = await openStore(storeTarget);
  const auth = new CloudAuth(loadAuthConfig(process.env));
  const router = createRouter({
    store,
    auth,
    logger: (level, entry) => console.log(JSON.stringify({ level, ...entry })),
    offlineAfterMs: Number(process.env.CLOUD_MACHINE_OFFLINE_MS || 60000)
  });
  cached = { store, auth, router };
  return cached;
}

export default async function handler(req, res) {
  try {
    const service = await getService();
    const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    let rawBody = '';
    if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
      rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    }
    const result = await service.router.handle({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: req.body && typeof req.body === 'object' ? req.body : (rawBody ? JSON.parse(rawBody) : {}),
      rawBody
    });
    res.status(result.status).setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.send(JSON.stringify(result.body, null, 2));
  } catch (error) {
    const { status, body } = errorBody(error);
    res.status(status).setHeader('content-type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(body));
  }
}
