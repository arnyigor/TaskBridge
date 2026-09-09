import { machineAuthHeaders, signRequest, bodyHash } from './machine-auth.mjs';

// Thin HTTP client for the cloud control plane. Only outbound requests; the
// local machine never listens for cloud traffic (§1).

export class CloudApiError extends Error {
  constructor({ code = 'INTERNAL_ERROR', message = 'Cloud request failed', status = 0, details = null, retryable = false } = {}) {
    super(message);
    this.name = 'CloudApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryable = retryable;
  }
}

export function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export class CloudClient {
  constructor({ baseUrl, machineId, machineSecret, authMode = 'bearer', protocolVersion = 1, timeoutMs = 20000, fetchImpl = globalThis.fetch, logger = null }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.machineId = machineId;
    this.machineSecret = machineSecret;
    this.authMode = authMode;
    this.protocolVersion = protocolVersion;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.logger = logger;
    if (!this.fetch) throw new Error('CloudClient requires fetch (Node.js 22+)');
  }

  #headers(method, path, body) {
    return {
      'content-type': 'application/json',
      accept: 'application/json',
      ...machineAuthHeaders({
        machineId: this.machineId,
        secret: this.machineSecret,
        authMode: this.authMode,
        method,
        path,
        body,
        protocolVersion: this.protocolVersion
      })
    };
  }

  async request(method, path, { body = null, query = null, timeoutMs = null } = {}) {
    const search = query ? `?${new URLSearchParams(query)}` : '';
    const url = `${this.baseUrl}${path}${search}`;
    const text = body == null ? null : JSON.stringify(body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Cloud request timeout')), timeoutMs ?? this.timeoutMs);
    let response;
    try {
      response = await this.fetch(url, {
        method,
        headers: this.#headers(method, path, text),
        body: text ?? undefined,
        signal: controller.signal
      });
    } catch (error) {
      clearTimeout(timer);
      throw new CloudApiError({
        code: 'NETWORK_ERROR',
        message: `Cloud unreachable: ${error?.message || error}`,
        retryable: true
      });
    }
    clearTimeout(timer);

    let payload = null;
    const raw = await response.text().catch(() => '');
    if (raw) {
      try { payload = JSON.parse(raw); } catch { payload = null; }
    }

    if (!response.ok) {
      const error = payload?.error || {};
      throw new CloudApiError({
        code: error.code || `HTTP_${response.status}`,
        message: error.message || `Cloud returned ${response.status}`,
        status: response.status,
        details: error.details ?? null,
        retryable: isRetryableStatus(response.status)
      });
    }
    return payload;
  }

  heartbeat(payload) { return this.request('POST', '/api/bridge/heartbeat', { body: payload }); }
  fetchCommands({ after = 0, limit = 50 } = {}) { return this.request('GET', '/api/bridge/commands', { query: { after, limit } }); }
  ackCommand(commandId, status, detail = null) {
    return this.request('POST', `/api/bridge/commands/${encodeURIComponent(commandId)}/ack`, { body: { status, ...(detail ? { detail } : {}) } });
  }
  uploadEvents(events) {
    return this.request('POST', '/api/bridge/events', { body: { machineId: this.machineId, protocolVersion: this.protocolVersion, events } });
  }
  reconcile(payload) { return this.request('POST', '/api/bridge/reconcile', { body: payload }); }

  // Exposed for tests and for the /debug/cloud endpoint; never prints the secret.
  describe() {
    return {
      baseUrl: this.baseUrl,
      machineId: this.machineId,
      authMode: this.authMode,
      protocolVersion: this.protocolVersion,
      signatureSample: this.authMode === 'hmac'
        ? signRequest({ secret: this.machineSecret, method: 'GET', path: '/api/bridge/commands', body: '', timestamp: '0' }).slice(0, 12) + '…'
        : null,
      bodyHashAlgorithm: bodyHash('').slice(0, 8)
    };
  }
}
