import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { acquireInstanceLock, imageNameOf } from '../src/instance-lock.mjs';

// Инцидент 2026-10-05: кнопка «Запустить сервер» отвечала «TaskBridge уже запущен
// (PID 13220)», когда такого процесса уже не было. Блокировка хранит только PID, а
// Windows переиспользует номера — на этой машине крутятся десятки node-процессов.
// Проверяем обе стороны: мёртвый/чужой держатель не должен блокировать старт, а
// живой наш сервер — должен.

const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('лок с мёртвым PID перехватывается', () => {
  const dir = temp('tb-lock-dead-');
  fs.writeFileSync(path.join(dir, 'taskbridge.lock'), JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }));
  const lock = acquireInstanceLock(dir);
  assert.ok(fs.readFileSync(path.join(dir, 'taskbridge.lock'), 'utf8').includes(String(process.pid)));
  lock.release();
});

test('старый процесс не удаляет лок нового владельца при выходе', () => {
  const dir = temp('tb-lock-owner-');
  const lock = acquireInstanceLock(dir, { mode: 'lan', internalPort: 50123, publicPort: 8787 });
  const file = path.join(dir, 'taskbridge.lock');
  const first = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(first.mode, 'lan');
  assert.equal(first.internalPort, 50123);

  const replacement = { pid: 424242, owner: 'replacement', mode: 'lan', internalPort: 50456, publicPort: 8787 };
  fs.writeFileSync(file, JSON.stringify(replacement));
  lock.release();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), replacement);
});

test('чужой node-процесс с переиспользованным PID не считается нашим сервером', (t) => {
  const dir = temp('tb-lock-foreign-');
  // Живой node, который НЕ является сервером TaskBridge: ровно та ловушка, из-за
  // которой сломался старт (образ node.exe совпадал, командная строка — нет).
  const foreign = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  t.after(() => foreign.kill());
  fs.writeFileSync(path.join(dir, 'taskbridge.lock'), JSON.stringify({ pid: foreign.pid, startedAt: new Date().toISOString() }));
  const lock = acquireInstanceLock(dir);
  assert.ok(lock, 'чужой node не должен держать каталог данных TaskBridge');
  lock.release();
});

test('живой наш сервер держит каталог данных', (t) => {
  const dir = temp('tb-lock-ours-');
  // Настоящий src/server.mjs в тесте поднимать нельзя (порты, Pi, состояние): берём
  // пустышку с тем же именем входа — командная строка совпадает с настоящим сервером.
  const script = path.join(temp('tb-lock-script-'), 'server.mjs');
  fs.writeFileSync(script, 'setTimeout(() => {}, 30000);\n');
  const ours = spawn(process.execPath, [script], { stdio: 'ignore' });
  t.after(() => ours.kill());
  fs.writeFileSync(path.join(dir, 'taskbridge.lock'), JSON.stringify({ pid: ours.pid, startedAt: new Date().toISOString() }));
  assert.throws(() => acquireInstanceLock(dir), (error) => error.code === 'ALREADY_RUNNING');
});

test('имя образа берётся только из строки процесса', () => {
  assert.equal(imageNameOf('"node.exe","1234","Console","1","10 000 КБ"'), 'node.exe');
  assert.equal(imageNameOf('"explorer.exe","10","Console","1","1 КБ"'), 'explorer.exe');
  // Русская локаль: для несуществующего PID tasklist печатает сообщение, а не строку процесса
  assert.equal(imageNameOf('ИНФОРМАЦИЯ: нет задач, соответствующих заданным условиям.'), null);
  assert.equal(imageNameOf(''), null);
});
