const fail = (message, code = 'CLOUD_UNAVAILABLE') => Object.assign(new Error(message), { code });

export class CloudClient {
  constructor(config, secret, options = {}) {
    this.baseUrl = String(config.url || '').replace(/\/$/, '');
    this.secret = secret;
    this.fetch = options.fetch || globalThis.fetch;
    this.timeoutMs = Number(config.timeoutMs || 15000);
    let url;
    try { url = new URL(this.baseUrl); } catch { throw fail('Некорректный cloud.url.', 'INPUT_INVALID'); }
    if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:')) throw fail('Cloud bridge должен использовать HTTPS.', 'INPUT_INVALID');
  }

  async request(route, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${route}`, {
        method: 'POST', signal: controller.signal,
        headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw fail(`Cloud bridge ответил ${response.status}: ${(await response.text()).slice(0, 500)}`);
      return response.status === 204 ? null : response.json();
    } catch (error) {
      if (error.code === 'CLOUD_UNAVAILABLE') throw error;
      throw fail(`Cloud bridge недоступен: ${error.message}`);
    } finally { clearTimeout(timer); }
  }

  publish(machineId, records) { return this.request('/api/bridge/events', { machineId, records }); }
  pull(machineId) { return this.request('/api/bridge/commands-pull', { machineId }); }
  ack(machineId, receiptHandle) { return this.request('/api/bridge/commands-ack', { machineId, receiptHandle }); }
}
