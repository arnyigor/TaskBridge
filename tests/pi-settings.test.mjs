import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPiSettings, imagesBlocked, piSettingsPath } from '../src/pi-settings.mjs';

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
