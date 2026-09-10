import crypto from 'node:crypto';

const COOKIE = 'taskbridge_cloud_session';
const safeEqual = (left, right) => {
  const a = crypto.createHash('sha256').update(String(left || '')).digest();
  const b = crypto.createHash('sha256').update(String(right || '')).digest();
  return crypto.timingSafeEqual(a, b);
};

function secret() {
  const value = process.env.TASKBRIDGE_WEB_SECRET;
  if (!value || value.length < 16) throw Object.assign(new Error('TASKBRIDGE_WEB_SECRET is not configured'), { status: 503 });
  return value;
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function sessionCookie() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })).toString('base64url');
  return `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`;
}

export function requireWeb(req) {
  const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map(item => item.trim().split(/=(.*)/s).slice(0, 2)).filter(([key]) => key));
  const token = cookies[COOKIE] || '';
  const dot = token.lastIndexOf('.');
  if (dot < 1 || !safeEqual(token.slice(dot + 1), sign(token.slice(0, dot)))) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  let payload;
  try { payload = JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString('utf8')); } catch {}
  if (!payload || !Number.isFinite(payload.exp) || payload.exp < Date.now()) throw Object.assign(new Error('Session expired'), { status: 401 });
}

export function verifyPassword(value) {
  if (!safeEqual(value, secret())) throw Object.assign(new Error('Invalid password'), { status: 401 });
}

export function requireMachine(req) {
  const expected = process.env.TASKBRIDGE_MACHINE_SECRET;
  if (!expected || expected.length < 16) throw Object.assign(new Error('Machine secret is not configured'), { status: 503 });
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(supplied, expected)) throw Object.assign(new Error('Unauthorized'), { status: 401 });
}
