import test from 'node:test';
import assert from 'node:assert/strict';
import { profile } from '../src/index.mjs';
import { label01 } from '../src/services/svc01.mjs';
import { greeting02 } from '../src/services/svc02.mjs';
import { planTag03 } from '../src/services/svc03.mjs';
import { shortName12 } from '../src/services/svc12.mjs';

test('сервисы первого плана', () => {
  assert.equal(label01('u1'), '01:Анна');
  assert.equal(greeting02('u1'), 'Привет, Анна (pro)');
  assert.equal(planTag03('u1'), 'plan=pro');
  assert.equal(shortName12('u1'), 'Анна (u1)');
});

test('профиль собирает все двенадцать подписей', () => {
  const view = profile('u1');
  assert.equal(view.id, 'u1');
  assert.equal(view.name, 'Анна');
  assert.deepEqual(view.labels, [
    '01:Анна',
    'Привет, Анна (pro)',
    'plan=pro',
    'Анна (u1)',
    '05:Анна',
    'Привет, Анна (pro)',
    'plan=pro',
    'Анна (u1)',
    '09:Анна',
    'Привет, Анна (pro)',
    'plan=pro',
    'Анна (u1)',
  ]);
});

test('неизвестный пользователь — ошибка', () => {
  assert.throws(() => profile('zz'), /нет пользователя zz/);
});
