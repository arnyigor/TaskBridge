export async function readJson(req, maxBytes = 512 * 1024) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let text = '';
  for await (const chunk of req) {
    text += chunk.toString('utf8');
    if (Buffer.byteLength(text) > maxBytes) throw Object.assign(new Error('Request is too large'), { status: 413 });
  }
  try { return text ? JSON.parse(text) : {}; }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

export function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

export function method(req, allowed) {
  if (allowed.includes(req.method)) return true;
  throw Object.assign(new Error('Method not allowed'), { status: 405 });
}

export function handler(action) {
  return async (req, res) => {
    try { await action(req, res); }
    catch (error) { json(res, error.status || 500, { error: error.message || 'Internal error', code: error.code || 'CLOUD_ERROR' }); }
  };
}
