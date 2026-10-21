import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_RESTART_DEFAULTS, autoRestartConfigured, autoRestartDecision, nextRestartAt, normalizeAutoRestart,
  previousRestartMoment,
} from '../src/auto-restart.mjs';
import { startFixture } from './server-fixture.mjs';

// Автоматический перезапуск сервера (запрос оператора 2026-10-14): таймер ставится,
// сервер перезапускается сам и поднимается обратно. Здесь проверяются РЕШЕНИЯ —
// расписание, минимальный аптайм, откладывание при живой работе. Само перезапускание
// идёт существующим путём POST /api/server/restart (та же функция triggerRestart).

const at5 = Date.parse('2026-10-14T05:00:00');
const start4 = Date.parse('2026-10-14T04:00:00');

test('nothing happens while the feature is off or has no schedule', () => {
  assert.equal(normalizeAutoRestart({}).enabled, false, 'по умолчанию выключено');
  assert.equal(autoRestartConfigured({ enabled: true }), false, 'без расписания перезапускать нечего');
  assert.equal(nextRestartAt({ enabled: false, at: '04:00' }, { now: at5 }), null, 'выключено — плана нет');
  assert.equal(autoRestartDecision({}, { now: at5 }).reason, 'disabled');
  assert.equal(autoRestartDecision({ enabled: true }, { now: at5 }).reason, 'no-schedule');
});

test('a daily time already passed today is scheduled for tomorrow, not immediately', () => {
  const next = nextRestartAt({ enabled: true, at: '04:00' }, { now: at5 });
  const local = new Date(next);
  assert.equal(local.getHours(), 4);
  assert.equal(local.getMinutes(), 0);
  assert.ok(next.getTime() > at5, 'иначе сервер, поднятый после 04:00, перезапускался бы вечно');
  assert.equal(next.getTime() - at5, 23 * 60 * 60 * 1000, `следующий — завтра в 04:00 (${next.toISOString()})`);
});

test('an interval counts from the server start', () => {
  const next = nextRestartAt({ enabled: true, everyHours: 6 }, { now: at5, startedAt: start4 });
  assert.equal(next.toISOString(), new Date(start4 + 6 * 3600 * 1000).toISOString());
  assert.equal(autoRestartDecision({ enabled: true, everyHours: 6 }, { now: at5, startedAt: start4 }).reason, 'not-due');
  const later = start4 + 6 * 3600 * 1000 + 1000;
  assert.equal(autoRestartDecision({ enabled: true, everyHours: 6, minUptimeMinutes: 0 }, { now: later, startedAt: start4 }).reason, 'due');
});

test('a freshly started server never restarts itself (no crash loop)', () => {
  const decision = autoRestartDecision({ enabled: true, everyHours: 1 }, {
    now: start4 + 60 * 1000, startedAt: start4, minUptimeMinutes: 10,
  });
  assert.equal(decision.restart, false);
  assert.equal(decision.reason, 'too-young');
});

test('live work is waited out, not interrupted', () => {
  const config = { enabled: true, everyHours: 1, minUptimeMinutes: 0 };
  const due = start4 + 90 * 60 * 1000;
  const busy = autoRestartDecision(config, { now: due, startedAt: start4, active: true });
  assert.equal(busy.restart, false);
  assert.equal(busy.reason, 'busy');
  assert.equal(busy.deferred, true, 'отложен, а не отменён — оператор видит причину');
  // Сессия освободилась — тот же тик уже перезапускает.
  assert.equal(autoRestartDecision(config, { now: due, startedAt: start4, active: false }).reason, 'due');
  // Явно попросили не ждать (`onlyWhenIdle: false`): перезапуск при живой работе.
  assert.equal(autoRestartDecision({ ...config, onlyWhenIdle: false }, { now: due, startedAt: start4, active: true }).reason, 'due');
});

test('a restart does not repeat sooner than minUptime after the previous one', () => {
  // Расписание наступило ровно час после старта, но предыдущий перезапуск был только
  // что: второй подряд не делаем — иначе сервер уходит в цикл «перезапустился и снова».
  const config = { enabled: true, everyHours: 1, minUptimeMinutes: 10, onlyWhenIdle: false };
  const due = start4 + 3600 * 1000;
  const guarded = autoRestartDecision(config, { now: due, startedAt: start4, lastRestartAt: due });
  assert.equal(guarded.restart, false);
  // Повтор выражен правилом «момент уже съеден»: наступление не позже прошлого
  // перезапуска не считается новым.
  assert.equal(guarded.reason, 'not-due');
  // Интервальное расписание ждёт СЛЕДУЮЩЕГО интервала, а не «через минуту после
  // предыдущего перезапуска»: +11 минут — это всё ещё первый час.
  assert.equal(autoRestartDecision(config, { now: due + 11 * 60 * 1000, startedAt: start4, lastRestartAt: due }).reason, 'not-due');
  // Второй интервал пришёл — перезапускаемся (прошлый перезапуск был раньше него).
  const secondMoment = start4 + 2 * 3600 * 1000;
  assert.equal(autoRestartDecision(config, { now: secondMoment + 60 * 1000, startedAt: start4, lastRestartAt: due }).reason, 'due');
});

test('junk in the config falls back to safe defaults', () => {
  const settings = normalizeAutoRestart({ enabled: true, at: '25:99', everyHours: -3, minUptimeMinutes: 'нет', tickSec: 1 });
  assert.equal(settings.at, null, 'некорректное время игнорируется');
  assert.equal(settings.everyHours, 0);
  assert.equal(settings.minUptimeMinutes, AUTO_RESTART_DEFAULTS.minUptimeMinutes);
  assert.equal(settings.tickSec, AUTO_RESTART_DEFAULTS.tickSec, 'слишком частый тик не принимается');
  assert.equal(settings.onlyWhenIdle, true);
});

test('the server shows the plan and the last decision in /api/info', { timeout: 60000 }, async t => {
  const fixture = await startFixture(undefined, {
    server: { autoRestart: { enabled: true, at: '04:00', minUptimeMinutes: 10, tickSec: 5 } },
  });
  t.after(() => fixture.close());

  const info = await fixture.api('/api/info');
  assert.equal(info.autoRestart.enabled, true);
  assert.equal(info.autoRestart.at, '04:00');
  assert.equal(info.autoRestart.onlyWhenIdle, true);
  assert.ok(info.autoRestart.nextAt, 'оператор видит момент следующего перезапуска');
  assert.equal(new Date(info.autoRestart.nextAt).getMinutes(), 0);
  assert.equal(info.autoRestart.lastRestartAt, null);
  // Пока сервер молодой, таймер молчит и говорит почему: цикл «перезапустился и снова»
  // недопустим.
  assert.equal(info.autoRestart.state.reason, 'idle', JSON.stringify(info.autoRestart));

  // Выключенный по умолчанию: у сервера без настройки плана нет.
  const plain = await startFixture();
  t.after(() => plain.close());
  const plainInfo = await plain.api('/api/info');
  assert.equal(plainInfo.autoRestart.enabled, false);
  assert.equal(plainInfo.autoRestart.nextAt, null);
});

test('a moment that passed while the server was up really triggers the restart', () => {
  // Дефект, найденный живой приёмкой 2026-10-14: проверка «пора?» шла через
  // БЛИЖАЙШИЙ момент, а он после наступления уезжает на завтра — сервер навсегда
  // оставался в состоянии not-due и не перезапускался.
  const config = { enabled: true, at: '02:16', minUptimeMinutes: 0 };
  const startedAt = Date.parse('2026-10-14T02:15:47');
  const moment = previousRestartMoment(config, { now: Date.parse('2026-10-14T02:16:20'), startedAt });
  assert.equal(new Date(moment).getHours(), 2);
  assert.equal(new Date(moment).getMinutes(), 16);
  assert.equal(autoRestartDecision(config, { now: Date.parse('2026-10-14T02:16:20'), startedAt }).reason, 'due');

  // После перезапуска тот же момент съеден: следующий — завтра.
  const restartedAt = Date.parse('2026-10-14T02:16:25');
  const after = autoRestartDecision(config, {
    now: Date.parse('2026-10-14T02:16:40'), startedAt: restartedAt, lastRestartAt: restartedAt,
  });
  assert.equal(after.reason, 'not-due', 'иначе сервер перезапускался бы каждую минуту');
  assert.equal(new Date(after.nextAt).getDate(), new Date(restartedAt).getDate() + 1);

  // Расписание, наступившее ДО старта процесса, не наше: свежий сервер не «догоняет»
  // пропущенные моменты.
  assert.equal(autoRestartDecision(config, {
    now: Date.parse('2026-10-14T03:00:00'), startedAt: Date.parse('2026-10-14T02:30:00'),
  }).reason, 'not-due');
});

test('an interval counts its moments from the start and never fires early', () => {
  const config = { enabled: true, everyHours: 1, minUptimeMinutes: 0 };
  const startedAt = Date.parse('2026-10-14T02:00:00');
  assert.equal(previousRestartMoment(config, { now: Date.parse('2026-10-14T02:30:00'), startedAt }), null, 'первого интервала ещё нет');
  assert.equal(autoRestartDecision(config, { now: Date.parse('2026-10-14T02:30:00'), startedAt }).reason, 'not-due');
  assert.equal(new Date(previousRestartMoment(config, { now: Date.parse('2026-10-14T03:10:00'), startedAt })).toISOString(),
    new Date(Date.parse('2026-10-14T03:00:00')).toISOString());
  assert.equal(autoRestartDecision(config, { now: Date.parse('2026-10-14T03:10:00'), startedAt }).reason, 'due');
});

// AUTO-01E, находка A5 (docs/auto-00-audit.md): «свободная машина» определялась только
// по занятым слотам, а очередь промптов живёт в памяти — рестарт по таймеру её терял.
test('очередь промптов делает машину занятой для автоперезапуска', async t => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { TaskStore } = await import('../src/task-store.mjs');
  const { TaskManager } = await import('../src/task-manager.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskbridge-pending-'));
  const store = new TaskStore(dir);
  const manager = new TaskManager({ projects: [] }, dir, store);
  t.after(async () => {
    try { await manager.close?.(); } catch { /* не предмет теста */ }
    store.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  assert.deepEqual(manager.pendingWork, { sessions: 0, queued: 0 });
  assert.equal(manager.hasPendingWork(), false, 'пустая машина свободна');

  manager.queue.push('task-queued');
  assert.deepEqual(manager.pendingWork, { sessions: 0, queued: 1 });
  assert.equal(manager.hasPendingWork(), true, 'очередь — тоже работа, хотя слотов нет');
  manager.queue.length = 0;

  manager.activeTaskIds.add('task-running');
  assert.equal(manager.hasPendingWork(), true, 'занятый слот по-прежнему блокирует рестарт');
});
