import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  upsertPreset, modelsPresetPath, registerLibraryPreset, patchPresetContext, removePreset,
  parsePresets, patchPresetVision,
} from '../src/router-presets.mjs';

const BASE = [
  'version = 1',
  '',
  '[*]',
  'n-gpu-layers = 999',
  'flash-attn = on',
  '',
  '[qwen-27b-vision]',
  'model = G:\\AIModels\\Qwen3.8-27B.gguf',
  'ctx-size = 33792'
].join('\n');

test('upsertPreset appends a new section and leaves the rest byte-identical', () => {
  const updated = upsertPreset(BASE, 'new-model', 'model = G:\\x.gguf\nctx-size = 32768');
  const head = updated.slice(0, BASE.length);
  assert.equal(head, BASE, 'существующий текст не тронут');
  assert.ok(updated.includes('[new-model]'));
  assert.ok(updated.endsWith('ctx-size = 32768\n'));
});

test('upsertPreset replaces an existing section in place, keeping neighbours', () => {
  const updated = upsertPreset(BASE, 'qwen-27b-vision', 'model = G:\\new.gguf\nctx-size = 65536');
  assert.ok(!updated.includes('G:\\AIModels\\Qwen3.8-27B.gguf'), 'старый model заменён');
  assert.ok(updated.includes('[*]\nn-gpu-layers = 999'), 'секция [*] на месте');
  assert.ok(updated.includes('[qwen-27b-vision]\nmodel = G:\\new.gguf'));
  assert.ok(updated.startsWith('version = 1'), 'глобальные ключи впереди секций');
});

test('upsertPreset preserves CRLF files and refuses unsafe section names', () => {
  const crlf = BASE.replaceAll('\n', '\r\n');
  const updated = upsertPreset(crlf, 'added', 'model = x.gguf');
  assert.ok(updated.startsWith(crlf), 'исходный текст не тронут');
  assert.ok(updated.includes('[added]\r\nmodel = x.gguf'), 'новая секция в CRLF-файле');
  assert.throws(() => upsertPreset(BASE, 'bad\r\nname', 'x'), /Недопустимое имя/);
  assert.throws(() => upsertPreset(BASE, 'bad]name', 'x'), /Недопустимое имя/);
});

test('modelsPresetPath finds --models-preset in router args', () => {
  assert.equal(modelsPresetPath(['--host', 'x', '--models-preset', 'C:\\m.ini']), 'C:\\m.ini');
  assert.equal(modelsPresetPath(['--models-preset']), null);
  assert.equal(modelsPresetPath(undefined), null);
});

test('registerLibraryPreset writes model + mmproj + ctx-size into models.ini', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-preset-'));
  try {
    const ini = path.join(root, 'models.ini');
    await fs.writeFile(ini, BASE, 'utf8');
    const result = await registerLibraryPreset({
      entry: {
        id: 'qwen3.8-27b-gguf-abc123d-Q4_K_M',
        files: [
          { path: 'G:\\m\\weights-Q4_K_M.gguf', size: 1 },
          { path: 'G:\\m\\mmproj-f16.gguf', size: 1 }
        ]
      },
      file: ini,
      ctxSize: 65536,
      routerAlive: true
    });
    assert.equal(result.preset, 'qwen3-8-27b-gguf-abc123d-q4-k-m');
    assert.equal(result.restartRequired, true);
    const text = await fs.readFile(ini, 'utf8');
    assert.ok(text.includes('[qwen3-8-27b-gguf-abc123d-q4-k-m]'));
    assert.ok(text.includes('model = G:\\m\\weights-Q4_K_M.gguf'));
    assert.ok(text.includes('mmproj = G:\\m\\mmproj-f16.gguf'));
    assert.ok(text.includes('ctx-size = 65536'));
    assert.ok(text.includes('version = 1'), 'глобальные ключи целы');
    // Повторная регистрация той же модели (те же файлы): файл не меняется.
    const before = await fs.readFile(ini, 'utf8');
    const again = await registerLibraryPreset({
      entry: {
        id: 'qwen3.8-27b-gguf-abc123d-Q4_K_M',
        files: [
          { path: 'G:\\m\\weights-Q4_K_M.gguf' },
          { path: 'G:\\m\\mmproj-f16.gguf' }
        ]
      },
      file: ini,
      ctxSize: 65536
    });
    assert.equal(again.changed, false);
    assert.equal(await fs.readFile(ini, 'utf8'), before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('registerLibraryPreset refuses entries without weights and missing router config', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-preset-bad-'));
  try {
    const ini = path.join(root, 'models.ini');
    await fs.writeFile(ini, BASE, 'utf8');
    await assert.rejects(
      () => registerLibraryPreset({ entry: { id: 'x', files: [{ path: 'G:\\m\\mmproj-f16.gguf' }] }, file: ini }),
      /нет файла весов/);
    await assert.rejects(
      () => registerLibraryPreset({ entry: { id: 'x', files: [{ path: 'G:\\m\\w.gguf' }] }, file: null }),
      /--models-preset/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('patchPresetContext replaces ctx-size in the section owning the model file', () => {
  const patched = patchPresetContext(BASE, 'G:\\AIModels\\Qwen3.8-27B.gguf', 65536);
  assert.ok(patched, 'секция найдена по полному пути');
  assert.equal(patched.previous, 33792);
  assert.equal(patched.changed, true);
  assert.ok(patched.text.includes('[qwen-27b-vision]\nmodel = G:\\AIModels\\Qwen3.8-27B.gguf\nctx-size = 65536'));
  assert.ok(patched.text.includes('[*]\nn-gpu-layers = 999'), 'секция [*] не тронута');
});

test('patchPresetContext falls back to basename match and inserts a missing ctx-size', () => {
  const ini = ['version = 1', '', '[*]', 'flash-attn = on', '', '[mymodel]', 'model = D:\\weights\\Model-Q4_K_M.gguf'].join('\n');
  const patched = patchPresetContext(ini, 'C:\\other\\Model-Q4_K_M.GGUF', 131072);
  assert.ok(patched, 'совпадение по имени файла, регистр не важен');
  assert.equal(patched.previous, null);
  assert.ok(patched.text.includes('[mymodel]\nmodel = D:\\weights\\Model-Q4_K_M.gguf\nctx-size = 131072'));
});

test('patchPresetContext returns null for foreign models and rejects junk context', () => {
  assert.equal(patchPresetContext(BASE, 'G:\\other\\unknown.gguf', 32768), null);
  assert.throws(() => patchPresetContext(BASE, 'G:\\AIModels\\Qwen3.8-27B.gguf', 0), /целое положительное/);
  assert.throws(() => patchPresetContext(BASE, 'G:\\AIModels\\Qwen3.8-27B.gguf', 4096.5), /целое положительное/);
});

test('removePreset cuts the section and keeps the rest byte-identical', () => {
  const updated = upsertPreset(BASE, 'doomed', 'model = x.gguf\nctx-size = 8192');
  const result = removePreset(updated, 'doomed');
  assert.ok(result);
  assert.equal(result.changed, true);
  assert.ok(!result.text.includes('[doomed]'));
  assert.ok(result.text.includes('[qwen-27b-vision]'));
  assert.ok(result.text.startsWith('version = 1'));
  assert.equal(removePreset(BASE, 'absent'), null);
});


// Файл в форме рабочего models.ini: те же веса у vision- и text-пресета, у
// text-пресета vision выключен ключом no-mmproj (llama.cpp понимает оба ключа).
const VISION_INI = [
  'version = 1',
  '',
  '[*]',
  'flash-attn = on',
  'metrics = true',
  '',
  '[qwen-27b-q3-vision]',
  'model = G:/m/Qwen3.8-27B-UD-Q3_K_XL.gguf',
  'mmproj = G:/m/mmproj-BF16.gguf',
  'ctx-size = 56320',
  '',
  '[qwen-27b-q3]',
  'model = G:/m/Qwen3.8-27B-UD-Q3_K_XL.gguf',
  'no-mmproj = true',
  'ctx-size = 102400',
  '',
  '[plain]',
  'model = G:/m/other.gguf',
  'ctx-size = 8192'
].join('\n');

test('parsePresets reads sections as data: paths and the vision flag', () => {
  const presets = parsePresets(VISION_INI);
  assert.deepEqual(presets.map(p => p.id), ['qwen-27b-q3-vision', 'qwen-27b-q3', 'plain'], '[*] и глобальные ключи — не пресеты');
  assert.equal(presets[0].vision, true, 'mmproj без no-mmproj — vision');
  assert.equal(presets[1].vision, false, 'no-mmproj выключает автоподбор проектора');
  assert.equal(presets[2].vision, false, 'без mmproj vision нет');
  assert.deepEqual(presets[0].paths, [
    { key: 'model', value: 'G:/m/Qwen3.8-27B-UD-Q3_K_XL.gguf' },
    { key: 'mmproj', value: 'G:/m/mmproj-BF16.gguf' }
  ]);
  // Контекст, device и прочие ключи путями не считаются.
  assert.deepEqual(presets[2].paths, [{ key: 'model', value: 'G:/m/other.gguf' }]);
  // `mmproj-auto = false` — тоже выключенный автоподбор: vision нет, хотя строка mmproj есть.
  assert.equal(parsePresets('[p]\nmodel = a.gguf\nmmproj = b.gguf\nmmproj-auto = false').find(p => p.id === 'p').vision, false);
  // Закомментированная строка проектора — не активный mmproj.
  assert.equal(parsePresets('[p]\nmodel = a.gguf\n; mmproj = b.gguf').find(p => p.id === 'p').vision, false);
});

test('patchPresetVision turns vision off by commenting the projector out, keeping the path', () => {
  const patched = patchPresetVision(VISION_INI, 'qwen-27b-q3-vision', { vision: false });
  assert.ok(patched);
  assert.equal(patched.previous, true);
  assert.equal(patched.changed, true);
  assert.equal(patched.mmproj, null, 'активного проектора больше нет');
  // Явный mmproj сильнее no-mmproj (= --no-mmproj-auto): выключает только
  // комментарий к строке — измерено на живом llama-server.
  assert.ok(patched.text.includes(
    '[qwen-27b-q3-vision]\nmodel = G:/m/Qwen3.8-27B-UD-Q3_K_XL.gguf\nno-mmproj = true\n; mmproj = G:/m/mmproj-BF16.gguf\nctx-size = 56320',
  ), 'строка проектора закомментирована, путь остался в файле');
  assert.ok(patched.text.includes('[*]\nflash-attn = on'), 'секция [*] не тронута');
  assert.ok(patched.text.includes('[plain]\nmodel = G:/m/other.gguf'), 'соседняя секция не тронута');
  // Повторное выключение ничего не меняет: файл остаётся байт-в-байт.
  const again = patchPresetVision(patched.text, 'qwen-27b-q3-vision', { vision: false });
  assert.equal(again.changed, false);
  assert.equal(again.text, patched.text);
});

test('patchPresetVision turns vision back on: uncomments the parked projector', () => {
  const off = patchPresetVision(VISION_INI, 'qwen-27b-q3-vision', { vision: false }).text;
  const on = patchPresetVision(off, 'qwen-27b-q3-vision', { vision: true });
  assert.equal(on.previous, false);
  assert.equal(on.changed, true);
  assert.equal(on.mmproj, 'G:/m/mmproj-BF16.gguf', 'путь найден в самом файле, искать по диску не нужно');
  assert.ok(on.text.includes(
    '[qwen-27b-q3-vision]\nmodel = G:/m/Qwen3.8-27B-UD-Q3_K_XL.gguf\nmmproj = G:/m/mmproj-BF16.gguf\nctx-size = 56320',
  ), 'vision-секция без no-mmproj, строка проектора раскомментирована');
  // Выключенный vision соседнего пресета не трогаем.
  assert.ok(on.text.includes('[qwen-27b-q3]\nmodel = G:/m/Qwen3.8-27B-UD-Q3_K_XL.gguf\nno-mmproj = true'));
  assert.equal(patchPresetVision(on.text, 'qwen-27b-q3-vision', { vision: true }).changed, false);
});

test('patchPresetVision reads mmproj-auto = false as vision off and clears the flag when enabling', () => {
  const auto = VISION_INI.replaceAll('no-mmproj = true', 'mmproj-auto = false');
  assert.equal(parsePresets(auto).find(p => p.id === 'qwen-27b-q3').vision, false, 'mmproj-auto = false — автоподбор выключен');
  const on = patchPresetVision(auto, 'qwen-27b-q3', { vision: true, mmproj: 'G:/m/mmproj-BF16.gguf' });
  assert.ok(!on.text.includes('mmproj-auto'), 'флаг автоподбора убран: vision задан явным mmproj');
  assert.ok(on.text.includes(
    '[qwen-27b-q3]\nmodel = G:/m/Qwen3.8-27B-UD-Q3_K_XL.gguf\nmmproj = G:/m/mmproj-BF16.gguf\nctx-size = 102400',
  ));
});

test('patchPresetVision inserts a projector when the section has none and refuses without one', () => {
  // [qwen-27b-q3] делит веса с vision-пресетом — путь проектора передаёт вызывающий.
  const patched = patchPresetVision(VISION_INI, 'qwen-27b-q3', { vision: true, mmproj: 'G:/m/mmproj-BF16.gguf' });
  assert.equal(patched.previous, false);
  assert.ok(patched.text.includes(
    '[qwen-27b-q3]\nmodel = G:/m/Qwen3.8-27B-UD-Q3_K_XL.gguf\nmmproj = G:/m/mmproj-BF16.gguf\nctx-size = 102400',
  ));
  assert.ok(patched.text.includes('no-mmproj = true\n; mmproj') === false, 'в соседней секции ничего не выключено');
  // Пресет уже выключен (no-mmproj, без mmproj): выключать нечего.
  assert.equal(patchPresetVision(VISION_INI, 'qwen-27b-q3', { vision: false }).changed, false);
  assert.throws(() => patchPresetVision(VISION_INI, 'plain', { vision: true }), /mmproj-проектора/);
  assert.throws(() => patchPresetVision(VISION_INI, 'plain', { vision: 'yes' }), /true или false/);
});

test('patchPresetVision returns null for a foreign row and preserves CRLF', () => {
  assert.equal(patchPresetVision(VISION_INI, 'not-in-this-file', { vision: false }), null);
  const crlf = VISION_INI.replaceAll('\n', '\r\n');
  const patched = patchPresetVision(crlf, 'plain', { vision: false });
  assert.ok(patched.text.startsWith('version = 1\r\n'));
  assert.ok(patched.text.includes('\r\n[plain]\r\nmodel = G:/m/other.gguf\r\nno-mmproj = true\r\n'));
});
