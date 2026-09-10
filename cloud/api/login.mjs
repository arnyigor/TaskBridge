import { handler, json, method, readJson } from '../lib/http.mjs';
import { sessionCookie, verifyPassword } from '../lib/auth.mjs';

export default handler(async (req, res) => {
  method(req, ['POST']);
  verifyPassword((await readJson(req, 16 * 1024)).password);
  json(res, 200, { ok: true }, { 'set-cookie': sessionCookie() });
});
