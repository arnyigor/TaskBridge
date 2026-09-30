import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CONTEXT_FLAG,
  KV_RESIDENT_FLAG,
  MIN_CONTEXT,
  MAX_CONTEXT,
  assertContext,
  missingModelPaths,
  modelPaths,
  patchEngineArg,
  readEngineArg,
  writeContextFile
} from '../src/engine-context.mjs';

// Размер контекста локальной модели — параметр ЗАГРУЗКИ, и у Strata он лежит в
// args её собственного конфига (`--max-context`), который читает serve/server.py.
// Правка обязана быть точечной: конфиг чужой (его пишет setup.py: отступы в один
// пробел, строки CRLF), и переформатирование всего файла ради одного числа — это
// уже чужая ошибка, а не наша настройка.

// Файл как у Strata (strata-iq3_s.json, порт 8083): CRLF, отступы в один пробел,
// args строками. BOM добавлен нарочно — у текущих файлов его нет, но server.py
// читает их как utf-8-sig, то есть допускает, и правка не должна его терять.
const REAL_ISH = '\uFEFF{\r\n "exe": "strata.exe",\r\n "args": [\r\n  "--pack",\r\n  "packs\\\\iq3_s",\r\n  "--max-context",\r\n  "262144",\r\n  "--kv",\r\n  "int8",\r\n  "--kv-resident",\r\n  "32768"\r\n ],\r\n "port": 8083\r\n}\r\n';

async function tmpdir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'tb-context-'));
}

test('readEngineArg reads the number after the flag, as a string or as a number', () => {
  assert.equal(readEngineArg(REAL_ISH, CONTEXT_FLAG), 262144);
  assert.equal(readEngineArg(REAL_ISH, KV_RESIDENT_FLAG), 32768);
  assert.equal(readEngineArg('{"args":["--ctx-size", 4096]}', '--ctx-size'), 4096);
  assert.equal(readEngineArg(REAL_ISH, '--nope'), null);
  assert.equal(readEngineArg('', CONTEXT_FLAG), null);
});

test('patchEngineArg changes the number only — the rest of the file stays byte-identical', () => {
  const patched = patchEngineArg(REAL_ISH, CONTEXT_FLAG, 131072);
  assert.equal(readEngineArg(patched, CONTEXT_FLAG), 131072);
  // Тот же BOM, те же CRLF и отступы: отличается ровно одно значение.
  assert.equal(patched.replace('131072', '262144'), REAL_ISH);
  // И обратная правка возвращает исходный файл байт в байт.
  assert.equal(patchEngineArg(patched, CONTEXT_FLAG, 262144), REAL_ISH);
});

test('patchEngineArg refuses to invent a flag that is not there', () => {
  assert.equal(patchEngineArg(REAL_ISH, '--max-ctx'), null);
  assert.equal(patchEngineArg('{"args":[]}', CONTEXT_FLAG), null);
});

test('assertContext keeps values inside the range the engine can hold', () => {
  assert.equal(assertContext(131072), 131072);
  assert.equal(assertContext('131072'), 131072);
  for (const bad of [1024, MAX_CONTEXT + 1, 0, -1, 1.5, 'abc', null, NaN]) {
    assert.throws(() => assertContext(bad), error => error.code === 'INPUT_INVALID', `должно быть отвергнуто: ${bad}`);
  }
  assert.equal(assertContext(MIN_CONTEXT), MIN_CONTEXT);
  assert.equal(assertContext(MAX_CONTEXT), MAX_CONTEXT);
});

test('writeContextFile rewrites the config atomically and reports what was there', async () => {
  const dir = await tmpdir();
  const file = path.join(dir, 'strata-iq3_s.json');
  await fs.writeFile(file, REAL_ISH, 'utf8');

  const written = await writeContextFile(file, 131072);
  assert.deepEqual(written, { context: 131072, previous: 262144, changed: true, resident: 32768 });
  assert.equal(await fs.readFile(file, 'utf8'), patchEngineArg(REAL_ISH, CONTEXT_FLAG, 131072));
  // Временного файла рядом не осталось.
  assert.deepEqual((await fs.readdir(dir)).sort(), ['strata-iq3_s.json']);

  // То же значение — файл не переписывается (и остаётся валидным JSON).
  const again = await writeContextFile(file, 131072);
  assert.equal(again.changed, false);
  assert.equal(JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/u, '')).args.includes('--max-context'), true);

  // Файл без --max-context не трогается вовсе, и это видно вызывающему.
  const other = path.join(dir, 'plain.json');
  await fs.writeFile(other, '{"args":["--kv","int8"]}', 'utf8');
  assert.equal(await writeContextFile(other, 65536), null);
  assert.equal(await fs.readFile(other, 'utf8'), '{"args":["--kv","int8"]}');
});

// Веса удаляют, а конфиг остаётся: без проверки файлов строка модели вечно висит
// «не загружена» с кнопкой «Загрузить», которая не может сработать.
test('modelPaths names the files the config needs, and gives up on a foreign one', () => {
  // Из REAL_ISH берутся exe и --pack; его же --max-context/--kv/--kv-resident файлов
  // не называют и в список попадать не должны. Значения путей — работа JSON.parse,
  // поэтому здесь проверяются флаги, а не экранирование бэкслешей.
  assert.deepEqual(modelPaths(REAL_ISH).map(item => item.flag), ['exe', '--pack']);
  assert.equal(modelPaths(REAL_ISH)[1].path, 'packs\\iq3_s');
  // Чужая схема или мусор: судить о файлах нечем, и это null, а не «файлов нет».
  assert.equal(modelPaths('{"providers":{}}'), null);
  assert.equal(modelPaths('not json'), null);
  assert.equal(modelPaths(''), null);
});

test('missingModelPaths separates «нет весов» from «проверять нечем»', async () => {
  const dir = await tmpdir();
  const pack = path.join(dir, 'packs', 'iq3_s');
  await fs.mkdir(pack, { recursive: true });
  const weights = path.join(dir, 'models', 'IQ3_S', 'native.gguf');
  const config = path.join(dir, 'strata-iq3_s.json');
  const body = JSON.stringify({
    exe: path.join(dir, 'engine', 'strata.exe'),
    args: ['--pack', pack, '--native', weights, '--kv-resident', '32768']
  });
  await fs.writeFile(config, body, 'utf8');

  // Ни движка, ни весов: сообщаются ровно отсутствующие пути (не «32768»).
  const missing = await missingModelPaths(body, config);
  assert.deepEqual(missing.sort(), [path.join(dir, 'engine', 'strata.exe'), weights].sort());

  await fs.mkdir(path.dirname(weights), { recursive: true });
  await fs.writeFile(weights, 'x');
  await fs.mkdir(path.join(dir, 'engine'), { recursive: true });
  await fs.writeFile(path.join(dir, 'engine', 'strata.exe'), 'x');
  assert.deepEqual(await missingModelPaths(body, config), []);

  // Относительный путь считается от папки конфига, а не от cwd процесса.
  const relative = JSON.stringify({ args: ['--pack', 'packs/iq3_s'] });
  assert.deepEqual(await missingModelPaths(relative, config), []);
});
