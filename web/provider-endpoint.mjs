// Shared by the browser wizard and the server: identical URL and transport rules.
const fail = (code, message) => Object.assign(new Error(message), { code });

export function providerEndpoint(raw) {
  if (typeof raw !== 'string' || raw.length > 512) throw fail('INPUT_INVALID', 'Некорректный адрес сервера модели.');
  let url;
  const value = raw.trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  try { url = new URL(hasScheme ? value : `https://${value}`); } catch { throw fail('INPUT_INVALID', 'Некорректный URL.'); }
  if (url.username || url.password || url.hash || url.search || !url.hostname || !['https:', 'http:'].includes(url.protocol)) {
    throw fail('INPUT_INVALID', 'Используйте URL HTTP(S) без логина, пароля, query и fragment.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const ipv4 = host.split('.').map(Number);
  const localV4 = ipv4.length === 4 && ipv4.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (ipv4[0] === 10 || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
      || (ipv4[0] === 192 && ipv4[1] === 168) || ipv4[0] === 127);
  const isV4 = ipv4.length === 4 && ipv4.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
  // Адреса служебных диапазонов (link-local 169.254 — там живёт metadata-сервис облака,
  // 0.0.0.0, multicast, зарезервированное) не проверяются даже как локальные:
  // проверка черновика и сохранение не должны уметь говорить с ними.
  const serviceV4 = isV4 && (ipv4[0] === 0 || ipv4[0] >= 224 || (ipv4[0] === 169 && ipv4[1] === 254));
  const serviceV6 = host !== '::1' && /^(fe80:|fc|fd|ff|::)/.test(host);
  if (serviceV4 || serviceV6) throw fail('INPUT_INVALID', 'Этот адрес не используется как сервер моделей.');
  const local = host === 'localhost' || host === '::1' || localV4;
  if (!hasScheme && local) url.protocol = 'http:';
  if (url.protocol === 'http:' && !local) throw fail('INPUT_INVALID', 'Обычный HTTP допустим только для localhost и локальных IPv4-адресов.');
  if (url.protocol === 'http:' && !localV4 && host !== 'localhost' && host !== '::1') throw fail('INPUT_INVALID', 'Локальный адрес не поддерживается.');
  const result = url.toString().replace(/\/+$/, '');
  if (result.length > 512) throw fail('INPUT_INVALID', 'Слишком длинный URL.');
  return { baseUrl: result, local };
}
