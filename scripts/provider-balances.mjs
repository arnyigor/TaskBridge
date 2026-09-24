// Остаток средств на облачных провайдерах, которые Pi уже настроил.
//
// Здесь только те провайдеры, у которых найден публичный эндпоинт баланса,
// принимающий API-ключ. Локальный llama.cpp не входит по определению (денег нет).
// Для остальных (clodex-openai, google, huggingface, github-copilot,
// openai-codex) баланс по ключу недоступен — разбор в docs/provider-balances.md.
//
// Запуск: node scripts/provider-balances.mjs [--json]
// Ключи берутся из окружения теми же именами, что в ~/.pi/agent/models.json.

const PROVIDERS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    url: 'https://api.deepseek.com/user/balance',
    keyEnv: 'DEEPSEEK_API_KEY',
    // {"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"36.83",...}, ...]}
    format: json => (Array.isArray(json?.balance_infos) ? json.balance_infos : [])
      .map(b => `${b.total_balance} ${b.currency}`)
      .join(' + ') || null
  },
  {
    id: 'routerai',
    label: 'RouterAI',
    url: 'https://routerai.ru/api/v1/credits',
    keyEnv: 'ROUTERAI_API_KEY',
    // {"data":{"credits":2097.6143708804548}} — валюта в ответе не указана
    format: json => (json?.data && Number.isFinite(json.data.credits))
      ? `${json.data.credits} credits`
      : null
  },
  {
    id: 'wormsoft',
    label: 'WormSoft',
    url: 'https://ai.wormsoft.ru/api/gpt/subscription-limit',
    keyEnv: 'WORMSOFT_API_KEY',
    // API сохраняет историческую опечатку subcription*.
    format: json => (json?.subcriptionType && Number.isFinite(Number(json.subcriptionLimit)))
      ? `${json.subcriptionLimit} credits (${json.subcriptionType})`
      : null
  }
];

async function fetchBalance(provider, key, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(provider.url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: ac.signal
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const json = await res.json();
    const value = provider.format(json);
    return value ? { value } : { error: 'в ответе нет поля баланса' };
  } catch (error) {
    return { error: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

const asJson = process.argv.includes('--json');
const rows = [];
for (const provider of PROVIDERS) {
  const key = process.env[provider.keyEnv];
  if (!key) {
    rows.push({ provider: provider.label, env: provider.keyEnv, balance: '—', note: `нет ${provider.keyEnv} в окружении` });
    continue;
  }
  const result = await fetchBalance(provider, key);
  rows.push({
    provider: provider.label,
    env: provider.keyEnv,
    balance: result.value ?? '—',
    note: result.error ?? ''
  });
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log(`| Провайдер | Переменная | Остаток | Примечание |`);
  console.log(`| --- | --- | --- | --- |`);
  for (const r of rows) {
    console.log(`| ${r.provider} | \`${r.env}\` | ${r.balance} | ${r.note} |`);
  }
}
