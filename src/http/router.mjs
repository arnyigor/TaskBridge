// Лёгкий роутер без зависимостей: у каждого маршрута ОБЯЗАТЕЛЬНО объявлена
// политика доступа, поэтому «эндпоинт оказался до access.require» становится
// невозможным по построению (именно так /api/cloud/config однажды оказался без
// проверки).
//
// auth:
//   'public' — без проверки (только то, что должно работать до пейринга);
//   'client' — access.require(req): localhost или спаренное устройство;
//   'local'  — дополнительно ТОЛЬКО сам компьютер (access.local(req)).
//
// Ошибки не перехватываются: их ловит общий catch в server.mjs и превращает в
// errorJson с кодом, как и раньше.

function compilePattern(pattern) {
  const names = [];
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
  return { regex: new RegExp(`^${escaped}$`), names };
}

const AUTH_LEVELS = ['public', 'client', 'local'];

export class Router {
  #routes = [];

  add(method, pattern, { auth = 'client' } = {}, handler) {
    if (!AUTH_LEVELS.includes(auth)) {
      throw new Error(`Неизвестный уровень доступа "${auth}" для ${method} ${pattern}`);
    }
    if (typeof handler !== 'function') {
      throw new Error(`Нет обработчика для ${method} ${pattern}`);
    }
    const { regex, names } = compilePattern(pattern);
    this.#routes.push({ method: String(method).toUpperCase(), regex, names, auth, handler });
    return this;
  }

  get(pattern, opts, handler) { return this.add('GET', pattern, opts, handler); }
  post(pattern, opts, handler) { return this.add('POST', pattern, opts, handler); }
  put(pattern, opts, handler) { return this.add('PUT', pattern, opts, handler); }
  patch(pattern, opts, handler) { return this.add('PATCH', pattern, opts, handler); }
  delete(pattern, opts, handler) { return this.add('DELETE', pattern, opts, handler); }
  /** Любой метод: для 405 на конкретном пути (иначе запрос ушёл бы в общий 404). */
  all(pattern, opts, handler) { return this.add('*', pattern, opts, handler); }

  /**
   * Пытается обработать запрос. true — маршрут совпал.
   * `pathname` сюда приходит уже декодированным (server.mjs декодирует URL один раз),
   * поэтому параметры повторно не декодируются: `%` в id иначе превратился бы в мусор.
   */
  async dispatch(req, res, { url, pathname, access, json, readJson }) {
    for (const route of this.#routes) {
      if (route.method !== '*' && route.method !== req.method) continue;
      const match = route.regex.exec(pathname);
      if (!match) continue;

      if (route.auth !== 'public') access.require(req);
      // 'local' — строже, чем «включён пейринг»: операция над всей машиной, а не
      // над одной сессией, поэтому loopback требуется всегда (как и раньше).
      if (route.auth === 'local' && !access.local(req)) {
        throw Object.assign(new Error('Операция доступна только на компьютере сервера.'), { code: 'FORBIDDEN' });
      }

      const params = {};
      route.names.forEach((name, idx) => { params[name] = match[idx + 1]; });
      await route.handler({ req, res, url, params, access, json, readJson });
      return true;
    }
    return false;
  }
}
