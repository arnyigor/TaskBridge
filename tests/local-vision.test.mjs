import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/task-store.mjs';
import { TaskManager } from '../src/task-manager.mjs';
import { parsePresets } from '../src/router-presets.mjs';

// models.ini в форме рабочего файла: vision-пресет с проектором, text-пресет на
// тех же весах (vision выключен no-mmproj) и пресет, чьи веса удалили с диска —
// именно такую строку надо уметь убрать из конфига.
function iniText({ weights, mmproj, other }) {
  return [
    'version = 1',
    '',
    '[*]',
    'flash-attn = on',
    '',
    '[qwen-27b-q3-vision]',
    `model = ${weights}`,
    `mmproj = ${mmproj}`,
    'ctx-size = 56320',
    '',
    '[qwen-27b-q3]',
    `model = ${weights}`,
    'no-mmproj = true',
    'ctx-size = 102400',
    '',
    '[qwen-27b-text]',
    `model = ${other}`,
    'no-mmproj = true',
    'ctx-size = 65536'
  ].join('\n');
}

async function routerSetup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-vision-'));
  const dataRoot = path.join(root, 'data');
  await fs.mkdir(dataRoot, { recursive: true });
  const weights = path.join(root, 'Qwen3.8-27B-UD-Q3_K_XL.gguf');
  const mmproj = path.join(root, 'mmproj-BF16.gguf');
  const other = path.join(root, 'Qwen3.8-27B-UD-IQ4_XS.gguf');   // файла нет: веса удалили
  await fs.writeFile(weights, Buffer.alloc(8));
  await fs.writeFile(mmproj, Buffer.alloc(4));
  const file = path.join(root, 'models.ini');
  await fs.writeFile(file, iniText({ weights, mmproj, other }), 'utf8');

  const store = new TaskStore(dataRoot);
  const manager = new TaskManager({
    projects: [],
    localRuntime: {
      provider: 'llama.cpp',
      router: { enabled: true, command: 'llama-server', args: ['--models-preset', file] }
    }
  }, dataRoot, store);
  t.after(async () => {
    await manager.close().catch(() => {});
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  // Живой роутер не нужен: /models отдаётся заглушкой, проверяется разбор
  // models.ini и правка секций — это и есть код под тестом.
  const modelPath = { 'qwen-27b-q3-vision': weights, 'qwen-27b-q3': weights, 'qwen-27b-text': other };
  manager.local.getStatus = async () => ({
    enabled: true, mode: 'router', provider: 'llama.cpp', reachable: true, state: 'EXTERNAL_RUNNING',
    models: Object.entries(modelPath).map(([id, p]) => ({ id, name: id, status: 'unloaded', modelPath: p })),
  });
  return { root, dataRoot, manager, file, weights, mmproj, other };
}

const readIni = file => fs.readFile(file, 'utf8');

test('localStatus marks preset rows with file presence, vision and removability', async t => {
  const { manager, other } = await routerSetup(t);
  const status = await manager.localStatus({ fresh: true });
  const byId = new Map(status.models.map(m => [m.id, m]));

  const vision = byId.get('qwen-27b-q3-vision');
  assert.equal(vision.filesPresent, true, 'веса и проектор на диске');
  assert.equal(vision.missingFile, null);
  assert.equal(vision.vision, true, 'mmproj без no-mmproj — vision');
  assert.equal(vision.visionEditable, true, 'секция в models.ini — править можно');
  assert.equal(vision.removable, true, 'секция в models.ini — запись конфига');

  const text = byId.get('qwen-27b-q3');
  assert.equal(text.vision, false, 'no-mmproj выключает vision');
  assert.equal(text.filesPresent, true);

  const gone = byId.get('qwen-27b-text');
  assert.equal(gone.filesPresent, false, 'веса удалили — строка обязана это сказать');
  assert.equal(gone.missingFile, other, 'назван именно отсутствующий файл');
  assert.equal(gone.removable, true, 'её и убираем из конфига');
});

test('setLocalVision comments the projector out and can turn it back on', async t => {
  const { manager, file, mmproj } = await routerSetup(t);
  // Выключение: строка проектора комментируется (её путь остаётся в файле),
  // автоподбор тоже выключается — по-другому vision не выключить.
  const off = await manager.setLocalVision('qwen-27b-q3-vision', false);
  assert.equal(off.changed, true);
  assert.equal(off.previous, true);
  assert.equal(off.vision, false);
  assert.equal(off.mmproj, null, 'активного проектора больше нет');
  const text = await readIni(file);
  assert.ok(text.includes(`no-mmproj = true\n; mmproj = ${mmproj}\n`), 'строка проектора закомментирована, путь сохранён');
  assert.ok(text.includes('[qwen-27b-q3]\n'), 'соседняя секция на месте');
  assert.equal(parsePresets(text).find(p => p.id === 'qwen-27b-q3-vision').vision, false);

  // Включение: строка раскомментируется — путь искать по диску не надо.
  const on = await manager.setLocalVision('qwen-27b-q3-vision', true);
  assert.equal(on.changed, true);
  assert.equal(on.previous, false);
  assert.equal(on.vision, true);
  assert.equal(on.mmproj, mmproj);
  const back = await readIni(file);
  assert.equal(parsePresets(back).find(p => p.id === 'qwen-27b-q3-vision').vision, true);
  // Повтор: файл не переписывается зря.
  const again = await manager.setLocalVision('qwen-27b-q3-vision', true);
  assert.equal(again.changed, false);
  assert.equal(await readIni(file), back);
});

test('setLocalVision finds a projector for a preset that has none: sibling weights first', async t => {
  const { manager, file, mmproj } = await routerSetup(t);
  const result = await manager.setLocalVision('qwen-27b-q3', true);
  assert.equal(result.changed, true);
  assert.equal(result.previous, false);
  assert.equal(result.mmproj, mmproj, 'проектор взят из секции с теми же весами');
  assert.equal(result.vision, true);
  const preset = parsePresets(await readIni(file)).find(p => p.id === 'qwen-27b-q3');
  assert.equal(preset.vision, true);
  assert.equal(preset.mmproj, mmproj);
});

test('setLocalVision and forgetLocalPreset refuse rows the server does not own', async t => {
  const { manager, file } = await routerSetup(t);
  const before = await readIni(file);
  await assert.rejects(() => manager.setLocalVision('qwen-27b-text', 'yes'), /true или false/);
  await assert.rejects(() => manager.setLocalVision('foreign-row', true), /нет секции \[foreign-row\]/);
  assert.equal(await manager.forgetLocalPreset('foreign-row'), null);
  assert.equal(await readIni(file), before, 'чужая строка файл не трогает');
});

test('forgetLocalPreset drops the section from models.ini and leaves the rest byte-identical', async t => {
  const { manager, file, weights } = await routerSetup(t);
  const before = await readIni(file);
  const removed = await manager.forgetLocalPreset('qwen-27b-text');
  assert.deepEqual({ preset: removed.preset, changed: removed.changed }, { preset: 'qwen-27b-text', changed: true });
  const after = await readIni(file);
  assert.ok(!after.includes('[qwen-27b-text]'), 'секция убрана');
  assert.ok(after.includes('[qwen-27b-q3-vision]') && after.includes('[qwen-27b-q3]'), 'остальные пресеты целы');
  assert.ok(after.startsWith('version = 1'), 'глобальные ключи целы');
  assert.ok(after.includes(`model = ${weights}`));
  assert.ok(before.length > after.length);
  // Файлы модели не тронуты: это действие про конфиг.
  assert.equal(await fs.readFile(weights).then(b => b.length), 8);
});

test('forgetLocalPreset refuses while the model is loaded', async t => {
  const { manager } = await routerSetup(t);
  const status = await manager.local.getStatus();
  manager.local.getStatus = async () => ({ ...status, models: status.models.map(m => m.id === 'qwen-27b-text' ? { ...m, status: 'loaded' } : m) });
  await assert.rejects(() => manager.forgetLocalPreset('qwen-27b-text'), /сначала остановите модель/);
});
