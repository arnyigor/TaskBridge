import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

async function fixture(run) {
  const local = path.resolve('.local');
  await fs.mkdir(local, { recursive: true });
  const root = await fs.mkdtemp(path.join(local, 'strata-sync-test-'));
  try {
    await fs.mkdir(path.join(root, 'scripts'));
    await fs.mkdir(path.join(root, 'agent'));
    await fs.copyFile('scripts/strata-providers.mjs', path.join(root, 'scripts/strata-providers.mjs'));
    const models = { providers: { strata: { baseUrl: 'http://127.0.0.1:9000/v1', models: [{ id: 'old', name: 'Old' }] } } };
    const modelsPath = path.join(root, 'agent/models.json');
    await fs.writeFile(modelsPath, JSON.stringify(models));
    const execute = () => spawnSync(process.execPath, [path.join(root, 'scripts/strata-providers.mjs')], {
      env: { ...process.env, PI_AGENT_DIR: path.join(root, 'agent') }, encoding: 'utf8'
    });
    await run({ root, modelsPath, models, execute });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('Strata sync leaves providers untouched when config or discovery is absent', async () => {
  await fixture(async ({ root, modelsPath, models, execute }) => {
    assert.equal(execute().status, 0);
    assert.deepEqual(JSON.parse(await fs.readFile(modelsPath, 'utf8')), models);
    await fs.writeFile(path.join(root, 'config.json'), '{}');
    assert.equal(execute().status, 0);
    assert.deepEqual(JSON.parse(await fs.readFile(modelsPath, 'utf8')), models);
  });
});

test('Strata sync refuses duplicate ports without rewriting providers', async () => {
  await fixture(async ({ root, modelsPath, models, execute }) => {
    const dir = path.join(root, 'configs');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ localRuntime: { externalDiscovery: { dir } } }));
    for (const name of ['a', 'b']) await fs.writeFile(path.join(dir, `strata-${name}.json`), JSON.stringify({ port: 9000, model_name: name }));
    assert.equal(execute().status, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(modelsPath, 'utf8')), models);
  });
});
