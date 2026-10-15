// Request adaptation and command delivery are independent of screen/DOM state.
export function newCommandId() {
  return globalThis.crypto?.randomUUID?.() || `cmd-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export function createCommandClient({ transport, storage = () => globalThis.localStorage, onAuthRequired = () => {} }) {
  function clientId() {
    try {
      const target = storage();
      let id = target.getItem('tbClientId');
      if (!id) { id = newCommandId(); target.setItem('tbClientId', id); }
      return id;
    } catch { return 'web-client'; }
  }

  async function api(path, options = {}) {
    const method = options.method || (options.body === undefined ? 'GET' : 'POST');
    const raw = options.body;
    const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : null;
    let body = raw;
    if (typeof raw === 'string') {
      try { body = JSON.parse(raw); } catch { body = undefined; }
    }
    try { return await transport.request(method, path, body, timeoutMs); }
    catch (error) {
      if (error.code === 'AUTH_REQUIRED') onAuthRequired();
      const network = !error.code || ['RELAY_OFFLINE', 'REQUEST_TIMEOUT'].includes(error.code);
      throw Object.assign(new Error(`${error.code || 'HTTP_ERROR'}: ${error.message}`), { code: error.code || 'HTTP_ERROR', network });
    }
  }

  async function commandApi(path, payload) {
    // Retry only a lost transport answer, once, with the same logical identity.
    // A durable receipt takes precedence over an unconfirmed HTTP response.
    const commandId = newCommandId();
    let networkError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await api(path, { method: 'POST', body: { ...payload, commandId, clientId: clientId() } });
      } catch (error) {
        if (!error.network || attempt) { networkError = error; break; }
      }
    }
    const status = await api(`/api/commands/${encodeURIComponent(commandId)}`).catch(() => null);
    const unknown = ['UNKNOWN_AFTER_CRASH', 'UNKNOWN_OUTCOME'].includes(networkError?.code)
      || ['UNKNOWN_AFTER_CRASH', 'UNKNOWN_OUTCOME'].includes(status?.status);
    if (unknown || status && ['ACCEPTED', 'DISPATCHING', 'COMPLETED'].includes(status.status)) {
      throw Object.assign(new Error('Отправка не подтверждена: соединение пропало. Возможно, сервер получил сообщение — проверьте историю.'), { commandId, ambiguous: true, cause: networkError });
    }
    throw Object.assign(networkError, { commandId });
  }

  return { api, commandApi };
}
