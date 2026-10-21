// Приёмка AUTO-03E на уровне, до которого можно дойти без браузера и телефона:
// решения сервера о запуске, итоговом статусе и уведомлении. Проверяется именно
// «сколько раз отправили» — на этом основании потом фиксируется PASS/FAIL/NOT_TESTED.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PushCenter } from '../src/push/push-center.mjs';
import { createInvocationNotifier } from '../src/automation/invocation-notifier.mjs';
import { startFixture } from './server-fixture.mjs';

/** Подставной push-сервис: считает отправки и хранит тела. */
function pushStub({ status = 201, fail = false } = {}) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), body: String(init.body ?? '') });
    if (fail) throw new Error('push service is down');
    return new Response('', { status });
  };
  return { requests, fetchImpl };
}

/** PushCenter указывает на подставной сервис: настоящая подписка не нужна. */
/**
 * Ключи подписки как у браузера: `p256dh` — настоящая точка P-256 (без неё
 * шифрование payload падает и отправки не происходит вовсе), `auth` — 16 байт.
 */
function fakeSubscription(suffix) {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-65);
  return {
    endpoint: `https://push.example.test/${suffix}`,
    keys: { p256dh: Buffer.from(raw).toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
  };
}

async function centerWithSubscription(stub, suffix = 'a') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-push-accept-'));
  const center = new PushCenter(dir, { fetchImpl: stub.fetchImpl });
  await center.load();
  const added = await center.subscribe(fakeSubscription(suffix));
  assert.ok(added !== false, 'подписка добавлена');
  return { center, dir };
}

test('E4: уведомление автоматизации уходит один раз и только по итогу проверки', async t => {
  const stub = pushStub();
  const { center, dir } = await centerWithSubscription(stub);
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));

  // Сервер видит инвокации через manager; здесь он подменён минимальным объектом.
  const invocations = new Map();
  const manager = {
    getInvocation: id => {
      const invocation = invocations.get(id);
      if (!invocation) throw Object.assign(new Error('нет'), { code: 'NOT_FOUND' });
      return invocation;
    },
    getTask: () => ({ scheduleNotify: 'always' }),
    getRecipe: () => ({ id: 'rc-1', name: 'Утренний аудит' }),
  };
  invocations.set('inv-ok', {
    id: 'inv-ok', trigger: 'schedule', status: 'FAILED', verification: 'FAILED',
    finishedAt: '2026-10-21T09:05:00.000Z', sessionId: 's1', recipeId: 'rc-1',
  });
  invocations.set('inv-manual', { id: 'inv-manual', trigger: 'manual', status: 'FAILED', sessionId: 's2', recipeId: 'rc-1' });
  invocations.set('inv-skip', { id: 'inv-skip', trigger: 'schedule', status: 'SKIPPED', sessionId: null, recipeId: 'rc-1' });

  const notify = createInvocationNotifier({ manager, push: center });
  const first = await notify(['inv-ok', 'inv-manual', 'inv-skip']);
  assert.equal(first.length, 1, `уведомление только об автоматизации: ${JSON.stringify(first)}`);
  assert.equal(stub.requests.length, 1, `ровно одна отправка: ${stub.requests.length}`);
  assert.match(first[0].body, /Утренний аудит/);
  assert.match(first[0].body, /проверка не пройдена/);

  // Повторная сверка того же id не создаёт вторую отправку.
  const second = await notify(['inv-ok']);
  assert.equal(second.length, 0);
  assert.equal(stub.requests.length, 1, 'второй отправки нет');

  // Доставка на устройстве не влияет на статус запуска: ошибка сервиса молча
  // проглатывается (её видит PushCenter в логах, но не приёмка).
  const failing = pushStub({ fail: true });
  const { center: badCenter, dir: badDir } = await centerWithSubscription(failing, 'b');
  t.after(() => fs.rm(badDir, { recursive: true, force: true }).catch(() => {}));
  const notifyBad = createInvocationNotifier({ manager, push: badCenter });
  await notifyBad(['inv-ok']);
  assert.equal(failing.requests.length, 1, 'попытка отправки была');
});

test('E4: пока проверка идёт, событие конца хода молчит (нет преждевременного push)', async () => {
  const { notificationFor } = await import('../src/push/push-center.mjs');
  const event = { type: 'TASK_SUCCEEDED', taskId: 's1', at: '2026-10-21T09:00:00.000Z' };
  // Обязательная проверка настроена и ещё выполняется.
  assert.equal(notificationFor(event, { title: 'Аудит', scheduleNotify: 'always', verificationStatus: 'RUNNING' }), null);
  // Обычная сессия и сессия без проверки по-прежнему уведомляют.
  assert.ok(notificationFor(event, { title: 'Чат', verificationStatus: 'NOT_CONFIGURED' }));
});

test('T01/T05/T08: расписание, ошибка модели и пропущенное время на живом экземпляре', { timeout: 180000 }, async t => {
  const fixture = await startFixture(undefined, {
    root: { verificationProfiles: { failing: ['node -e "process.exit(1)"'] } },
  });
  t.after(() => fixture.close());
  const { api } = fixture;
  const [project] = await api('/api/projects');
  const headers = { 'content-type': 'application/json' };
  const post = async (route, body) => {
    const response = await fetch(fixture.base + route, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await response.text();
    assert.equal(response.status, 201, `POST ${route} → ${response.status}: ${text}`);
    return JSON.parse(text);
  };

  // T01: рецепт и расписание создаются согласованно.
  const recipe = await post('/api/recipes', {
    projectId: project.id, name: 'Приёмка', promptTemplate: 'Проверь {{area}}.',
    parameters: { area: { type: 'string', default: 'all' } },
    verification: { required: true, command: 'failing' },
  });
  const schedule = await post('/api/schedules', { recipeId: recipe.id, spec: { kind: 'daily', at: '09:00' } });
  assert.equal(schedule.recipeId, recipe.id);
  assert.ok(schedule.nextRunAt, 'момент посчитан сервером');
  const listed = await api('/api/schedules');
  assert.ok(listed.items.some(item => item.id === schedule.id));

  // T08: расписание, пропущенное «на три дня», не превращается в три запуска.
  const late = new Date(Date.parse(schedule.nextRunAt) + 3 * 24 * 60 * 60_000).toISOString();
  const tickResponse = await fetch(`${fixture.base}/api/scheduler/tick`, {
    method: 'POST', headers, body: JSON.stringify({ now: late }),
  });
  assert.equal(tickResponse.status, 200);
  const tick = await tickResponse.json();
  const decision = tick.decisions.find(entry => entry.scheduleId === schedule.id);
  assert.equal(decision.action, 'run', JSON.stringify(tick.decisions));

  // T05: ход завершился, обязательная проверка падает → запуск не «успешен».
  const until = async (check, ms = 60000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await check()) return;
      if (Date.now() > deadline) throw new Error('истекло время ожидания');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  await until(async () => {
    const session = await api(`/api/tasks/${decision.sessionId}`);
    return ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(session.status);
  });
  await until(async () => (await api(`/api/tasks/${decision.sessionId}`)).verificationStatus === 'FAILED');
  await fetch(`${fixture.base}/api/scheduler/tick`, {
    method: 'POST', headers, body: JSON.stringify({ now: new Date(Date.parse(late) + 60_000).toISOString() }),
  });
  const invocation = await api(`/api/invocations/${decision.invocationId}`);
  assert.equal(invocation.status, 'FAILED', JSON.stringify(invocation));
  assert.equal(invocation.verification, 'FAILED');

  // Повторный тик не создаёт второй запуск и не меняет завершённый.
  await fetch(`${fixture.base}/api/scheduler/tick`, {
    method: 'POST', headers, body: JSON.stringify({ now: new Date(Date.parse(late) + 120_000).toISOString() }),
  });
  
  const after = await api(`/api/invocations?scheduleId=${schedule.id}`);
  const ran = after.items.filter(item => item.status !== 'SKIPPED');
  assert.equal(ran.length, 1, `один фактический запуск: ${JSON.stringify(after.items.map(item => ({ id: item.id, status: item.status })))}`);
  // Пропущенная по политике запись — тоже информация, но двух запусков одного
  // момента быть не должно.
  assert.equal(new Set(ran.map(item => item.scheduledAt)).size, ran.length, 'нет двух запусков одного момента');
  assert.equal((await api(`/api/invocations/${decision.invocationId}`)).status, 'FAILED');

  // Сводка запуска доступна и не выдумывает значения.
  const summaryResponse = await fetch(`${fixture.base}/api/invocations/${decision.invocationId}/summary`);
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();
  assert.equal(summary.status, 'FAILED');
  assert.equal(summary.verification, 'FAILED');
  assert.ok(Number.isFinite(summary.durationMs) || summary.durationMs === null);
});
