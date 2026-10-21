import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPiSettings, imagesBlocked, piSettingsPath, piAgentDir } from '../src/pi-settings.mjs';

test('pi settings are read from the agent dir and blockImages is detected', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-pi-settings-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const env = { PI_AGENT_DIR: dir };
  assert.equal(piSettingsPath(env), path.join(dir, 'settings.json'));

  // Missing file → no settings, images not considered blocked.
  assert.equal(await readPiSettings(env), null);
  assert.equal(imagesBlocked(null), false);

  await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ images: { blockImages: true } }));
  const settings = await readPiSettings(env);
  assert.equal(imagesBlocked(settings), true);

  await fs.writeFile(path.join(dir, 'settings.json'), '{ not json');
  assert.equal(await readPiSettings(env), null);
});

test('agent dir follows Pi\'s own variable, with the old name as an alias', () => {
  // Pi 1.3.0 читает PI_CODING_AGENT_DIR (docs/environment-variables.md).
  // PI_AGENT_DIR остаётся совместимым алиасом: старые конфигурации TaskBridge
  // ставили именно его, и перестать его понимать — сломать их молча.
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: '/pi/agent' }), '/pi/agent');
  assert.equal(piAgentDir({ PI_AGENT_DIR: '/legacy/agent' }), '/legacy/agent');
  // Обе заданы — побеждает та, которую действительно читает Pi.
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: '/pi/agent', PI_AGENT_DIR: '/legacy/agent' }), '/pi/agent');
  // Ни одной — прежний путь по умолчанию.
  assert.equal(piAgentDir({}), path.join(os.homedir(), '.pi', 'agent'));
  // Пустая строка не должна превращаться в каталог '' — это ошибка оператора,
  // а не путь.
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: '', PI_AGENT_DIR: '' }), path.join(os.homedir(), '.pi', 'agent'));
});
