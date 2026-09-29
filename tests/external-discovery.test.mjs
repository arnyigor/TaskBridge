import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isLocalBaseUrl,
  portOfBaseUrl,
  readServerConfigs,
  discoverExternalServers
} from '../src/external-discovery.mjs';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tb-discovery-'));
}

test('isLocalBaseUrl takes only this machine', () => {
  assert.equal(isLocalBaseUrl('http://127.0.0.1:8083/v1'), true);
  assert.equal(isLocalBaseUrl('http://localhost:8080'), true);
  assert.equal(isLocalBaseUrl('http://[::1]:9000/v1'), true);
  assert.equal(isLocalBaseUrl('https://api.deepseek.com'), false);
  assert.equal(isLocalBaseUrl('http://192.168.1.10:8080'), false);
  assert.equal(isLocalBaseUrl(''), false);
  assert.equal(isLocalBaseUrl(null), false);
});

test('portOfBaseUrl reads the port, defaults by protocol', () => {
  assert.equal(portOfBaseUrl('http://127.0.0.1:8083/v1'), 8083);
  assert.equal(portOfBaseUrl('http://localhost'), 80);
  assert.equal(portOfBaseUrl('https://localhost'), 443);
  assert.equal(portOfBaseUrl('nonsense'), null);
});

test('readServerConfigs picks the port and --max-context out of each run config', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'strata-iq3_s.json'), JSON.stringify({
    port: 8083,
    args: ['--max-context', '262144', '--kv', 'int8']
  }));
  fs.writeFileSync(path.join(dir, 'strata-iq2_xs.json'), JSON.stringify({
    port: 8081,
    args: ['--max-context', '131072']
  }));
  fs.writeFileSync(path.join(dir, 'strata-broken.json'), '{ not json');
  fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ port: 9999 }));

  const configs = readServerConfigs(dir).sort((a, b) => a.port - b.port);
  assert.deepEqual(configs.map(c => [c.name, c.port, c.contextWindow]), [
    ['strata-iq2_xs.json', 8081, 131072],
    ['strata-iq3_s.json', 8083, 262144]
  ]);
});

test('discoverExternalServers builds loadable rows from Pi models.json', () => {
  const agentDir = tmpdir();
  const install = tmpdir();
  fs.writeFileSync(path.join(install, 'strata-iq3_s.json'), JSON.stringify({
    port: 8083,
    args: ['--max-context', '262144']
  }));
  fs.writeFileSync(path.join(install, 'strata-iq2_xs.json'), JSON.stringify({
    port: 8081,
    args: ['--max-context', '131072']
  }));
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      'strata-iq3s': {
        baseUrl: 'http://127.0.0.1:8083/v1',
        api: 'openai-completions',
        apiKey: 'local',
        models: [{ id: 'qwen3.8-flash-next-iq3-s', name: 'Qwen3.8 IQ3_S', contextWindow: 262144 }]
      },
      'strata-iq2': {
        baseUrl: 'http://127.0.0.1:8081/v1',
        api: 'openai-completions',
        apiKey: 'local',
        models: [{ id: 'qwen3.8-flash-next-iq2-xs', contextWindow: 131072 }]
      },
      deepseek: {
        baseUrl: 'https://api.deepseek.com',
        api: 'openai-completions',
        models: [{ id: 'deepseek-flash' }]
      }
    }
  }));

  const found = discoverExternalServers({
    agentDir,
    discovery: { dir: install }
  });
  assert.deepEqual(found.map(e => e.provider), ['strata-iq3s', 'strata-iq2']);

  const s = found[0];
  assert.equal(s.model, 'qwen3.8-flash-next-iq3-s');
  assert.equal(s.baseUrl, 'http://127.0.0.1:8083');
  assert.equal(s.contextWindow, 262144);
  assert.equal(s.cwd, install);
  // Команда запуска: интерпретатор и server.py внутри каталога установки,
  // конфиг найден сопоставлением порта.
  assert.deepEqual(s.start, [
    path.join(install, '.venv', 'Scripts', 'python.exe'),
    path.join(install, 'serve', 'server.py'),
    '--engine', 'strata',
    '--config', path.join(install, 'strata-iq3_s.json'),
    '--port', '8083'
  ]);
});

test('a configured entry wins over the discovered one', () => {
  const agentDir = tmpdir();
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      'strata-iq3s': {
        baseUrl: 'http://127.0.0.1:8083/v1',
        apiKey: 'local',
        models: [{ id: 'qwen3.8-flash-next-iq3-s' }]
      }
    }
  }));
  const configured = [{ provider: 'strata-iq3s', model: 'qwen3.8-flash-next-iq3-s', baseUrl: 'http://127.0.0.1:8083' }];
  assert.deepEqual(discoverExternalServers({ agentDir, configured }), []);
});

test('a local provider whose run config is not in the install dir is skipped', () => {
  // Так отсеиваются локальные прокси/релеи: они видны в Pi как localhost, но
  // это не наши серверы (нет конфига в каталоге установки).
  const agentDir = tmpdir();
  const install = tmpdir();
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      'strata-iq9': {
        baseUrl: 'http://127.0.0.1:8099/v1',
        apiKey: 'local',
        models: [{ id: 'qwen3.8-flash-next-iq9' }]
      }
    }
  }));
  assert.deepEqual(discoverExternalServers({ agentDir, discovery: { dir: install } }), []);
});

test('the local router and its port are never taken for an external server', () => {
  const agentDir = tmpdir();
  const install = tmpdir();
  // Роутер: llama.cpp на 8080 — под него есть подходящий по маске конфиг,
  // чтобы проверить именно исключение по имени и по порту.
  fs.writeFileSync(path.join(install, 'strata-router.json'), JSON.stringify({ port: 8080, args: ['--max-context', '65536'] }));
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      'llama.cpp': { baseUrl: 'http://127.0.0.1:8080/v1', apiKey: 'local', models: [{ id: 'qwen-27b-q3' }] },
      gemini: { baseUrl: 'http://127.0.0.1:8080/v1', apiKey: 'local', models: [{ id: 'gemini-3.8-flash' }] }
    }
  }));
  const found = discoverExternalServers({
    agentDir,
    discovery: { dir: install, healthUrl: 'http://127.0.0.1:8080/health' },
    exclude: ['llama.cpp']
  });
  assert.deepEqual(found, []);
});

test('a missing or unreadable models.json discovers nothing', () => {
  assert.deepEqual(discoverExternalServers({ agentDir: tmpdir() }), []);
  assert.deepEqual(discoverExternalServers({}), []);
});
