// Provider account status lives under the exact Pi provider of the active model.
// The test executes the real renderer functions extracted from web/app.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(root, 'web', 'app.js'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `в app.js нет функции ${name}`);
  let depth = 0;
  let i = source.indexOf('{', start);
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`не найдена закрывающая скобка для ${name}`);
}

const HTML = `<!doctype html><html><body>
  <div id="pcStateModel" class="pcStateModel"></div>
  <div id="pcStateProvider" class="pcStateProvider hidden"></div>
  <div id="pcStateSystem" class="pcStateSystem"></div>
</body></html>`;

function makeRenderer() {
  const { document } = parseHTML(HTML);
  const $ = (id) => document.getElementById(id);
  const names = [
    'providerStatusForModel', 'deepseekStatusText', 'wormsoftStatusText',
    'providerStatusText', 'renderProviderStatus',
  ];
  const factory = new Function('document', '$', `${names.map(name => extractFunction(appSource, name)).join('\n')}\nreturn renderProviderStatus;`);
  return { document, renderProviderStatus: factory(document, $) };
}

const deepseek = {
  provider: 'deepseek', label: 'DeepSeek', kind: 'balance', available: true,
  balance: { cny: -1.45, usd: 21.52 }, rub: { total: 1788.5 },
  runway: { historyDays: 11 }, pace: { historyPerDay: 13.278994, historyPerDayRub: 166.6 },
};
const wormsoft = {
  provider: 'wormsoft', label: 'WormSoft', kind: 'subscription', available: true,
  subscription: {
    plan: 'payed', remaining: 1_402_275, total: 3_000_000,
    remainingRatio: 1_402_275 / 3_000_000, windowSeconds: 14_400,
    periodDays: 30, priceRub: 4_000, rateLimitRequests: 120,
    rateLimitSeconds: 60, concurrentRequests: 5,
  },
};
const routerai = { provider: 'routerai', label: 'RouterAI', kind: 'credits', available: true, credits: 2097.61 };
const statuses = { deepseek, wormsoft, routerai };

test('DeepSeek balance keeps its currency and runway details', () => {
  const { document, renderProviderStatus } = makeRenderer();
  renderProviderStatus(statuses, { provider: 'deepseek', id: 'deepseek-flash' });
  const el = document.getElementById('pcStateProvider');
  assert.match(el.textContent, /^DeepSeek: ¥-1\.45 · \$21\.52 · \(≈ 1\u00a0789 ₽\)\nХватит примерно на 11 дн\./u);
  assert.equal(el.classList.contains('hidden'), false);
});

test('WormSoft shows its subscription remainder and verified plan limits', () => {
  const { document, renderProviderStatus } = makeRenderer();
  renderProviderStatus(statuses, { provider: 'wormsoft', id: 'deepseek-ai/deepseek-v4-pro' });
  const text = document.getElementById('pcStateProvider').textContent;
  // The panel stays minimal: remainder, the window verdict and a measured
  // reset countdown. Plan prices, static rate limits and calendar projections
  // are cabinet material, not per-poll status lines.
  assert.equal(text, 'WormSoft: осталось 1\u00a0402\u00a0275 из 3\u00a0000\u00a0000 кредитов (47%)');
});

test('WormSoft answers the window question with the measured rate and reset', () => {
  const { document, renderProviderStatus } = makeRenderer();
  const measured = {
    ...wormsoft,
    usage: {
      firstSeenAt: '2026-09-23T09:30:00.000Z',
      windowStartAt: '2026-09-28T09:00:00.000Z',
      perDay: 480_000,
      projectedEmptyAt: '2026-09-28T12:00:00.000Z',
      nextResetAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    },
  };
  const clock = value => new Date(value).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  renderProviderStatus({ wormsoft: measured }, { provider: 'wormsoft', id: 'x' });
  const text = document.getElementById('pcStateProvider').textContent;
  // The reset is named with an absolute clock time (the viewer's locale), and
  // the verdict says whether the measured supply reaches it: 1 402 275 at
  // 480k/day lasts ~70 h — far beyond the reset in 2 h.
  assert.equal(text, `WormSoft: осталось 1\u00a0402\u00a0275 из 3\u00a0000\u00a0000 кредитов (47%)\nсброс лимитов в ${clock(measured.usage.nextResetAt)} (замер) · запаса до сброса хватает`);
  assert.doesNotMatch(text, /не хватит|окна 4 ч|расход|подписка/u);

  // A tight case: the supply does not reach the next refresh.
  const tight = {
    ...measured,
    subscription: { ...measured.subscription, remaining: 60_000, remainingRatio: 0.02 },
    usage: { ...measured.usage, nextResetAt: new Date(Date.now() + 4 * 3_600_000).toISOString() },
  };
  renderProviderStatus({ wormsoft: tight }, { provider: 'wormsoft', id: 'x' });
  assert.equal(
    document.getElementById('pcStateProvider').textContent,
    `WormSoft: осталось 60\u00a0000 из 3\u00a0000\u00a0000 кредитов (2%)\nсброс лимитов в ${clock(tight.usage.nextResetAt)} (замер) · запаса до сброса не хватит`,
  );

  // Without a measured rate the verdict is impossible — the reset time alone.
  const withoutRate = {
    ...wormsoft,
    usage: { nextResetAt: new Date(Date.now() + 30 * 60_000).toISOString() },
  };
  renderProviderStatus({ wormsoft: withoutRate }, { provider: 'wormsoft', id: 'x' });
  assert.equal(
    document.getElementById('pcStateProvider').textContent,
    `WormSoft: осталось 1\u00a0402\u00a0275 из 3\u00a0000\u00a0000 кредитов (47%)\nсброс лимитов в ${clock(withoutRate.usage.nextResetAt)} (замер)`,
  );

  // No measured reset: the supply duration is the fallback, with the note that
  // explains the missing reset time instead of guessing it.
  const noReset = {
    ...measured,
    usage: { firstSeenAt: '2026-09-23T09:30:00.000Z', perDay: 480_000 },
  };
  renderProviderStatus({ wormsoft: noReset }, { provider: 'wormsoft', id: 'x' });
  assert.equal(
    document.getElementById('pcStateProvider').textContent,
    'WormSoft: осталось 1\u00a0402\u00a0275 из 3\u00a0000\u00a0000 кредитов (47%)\nзапаса хватит на ~3 дн. (сброс не измерен)',
  );

  // A stale reset estimate (already overdue) counts as unmeasured — no line
  // with a past time, not a made-up one.
  const staleReset = { ...measured, usage: { ...measured.usage, nextResetAt: new Date(Date.now() - 3_600_000).toISOString() } };
  renderProviderStatus({ wormsoft: staleReset }, { provider: 'wormsoft', id: 'x' });
  assert.equal(
    document.getElementById('pcStateProvider').textContent,
    'WormSoft: осталось 1\u00a0402\u00a0275 из 3\u00a0000\u00a0000 кредитов (47%)\nзапаса хватит на ~3 дн. (сброс не измерен)',
  );
});



test('account selection uses exact provider, not a model family in the id', () => {
  const { document, renderProviderStatus } = makeRenderer();
  renderProviderStatus(statuses, { provider: 'routerai', id: 'deepseek/deepseek-v4-flash' });
  const text = document.getElementById('pcStateProvider').textContent;
  assert.match(text, /^RouterAI: 2\u00a0097,61 кредитов$/u);
  assert.doesNotMatch(text, /DeepSeek|WormSoft/u);
});

test('unsupported or unavailable provider has no account line', () => {
  const { document, renderProviderStatus } = makeRenderer();
  for (const [set, model] of [
    [statuses, null],
    [statuses, { provider: 'google', id: 'gemini' }],
    [{ wormsoft: { available: false, reason: 'no-key' } }, { provider: 'wormsoft', id: 'x' }],
  ]) {
    renderProviderStatus(set, model);
    const el = document.getElementById('pcStateProvider');
    assert.equal(el.textContent, '');
    assert.ok(el.classList.contains('hidden'));
  }
});

test('repeated render with identical text does not replace the text node', () => {
  const { document, renderProviderStatus } = makeRenderer();
  renderProviderStatus(statuses, { provider: 'wormsoft', id: 'x' });
  const el = document.getElementById('pcStateProvider');
  const node = el.firstChild;
  renderProviderStatus(statuses, { provider: 'wormsoft', id: 'x' });
  assert.ok(el.firstChild === node, 'узел не пересоздавался');
});
test('an exhausted WormSoft counter reads as exhausted, not as negative hours', () => {
  const { document, renderProviderStatus } = makeRenderer();
  const overrun = {
    ...wormsoft,
    subscription: { ...wormsoft.subscription, remaining: -14_685, remainingRatio: -14_685 / 3_000_000 },
    usage: { perDay: 480_000 },
  };
  renderProviderStatus({ wormsoft: overrun }, { provider: 'wormsoft', id: 'x' });
  // No percent and no negative hours: the counter is simply exhausted.
  const expected = [
    'WormSoft: осталось -14\u00a0685 из 3\u00a0000\u00a0000 кредитов',
    'кредиты исчерпаны (сброс не измерен)',
  ].join('\n');
  assert.equal(document.getElementById('pcStateProvider').textContent, expected);
});



test('a provider the poll has not fetched shows a click hint instead of nothing', () => {
  const { document, renderProviderStatus } = makeRenderer();
  renderProviderStatus(
    { wormsoft: { provider: 'wormsoft', available: false, reason: 'not-fetched' } },
    { provider: 'wormsoft', id: 'x' },
  );
  const el = document.getElementById('pcStateProvider');
  assert.equal(el.classList.contains('hidden'), false);
  assert.match(el.textContent, /нажмите, чтобы обновить/i);
  // Other unavailable reasons (no key, provider down) keep no line.
  renderProviderStatus(
    { wormsoft: { provider: 'wormsoft', available: false, reason: 'no-key' } },
    { provider: 'wormsoft', id: 'x' },
  );
  assert.equal(document.getElementById('pcStateProvider').classList.contains('hidden'), true);
});
