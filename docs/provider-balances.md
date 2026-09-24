# Провайдеры Pi: доступные модели и остаток средств

Снимок на 2026-09-20 (UTC+3). Локальный провайдер `llama.cpp` исключён.

Источники данных:

- список моделей — проба Pi через `get_available_models` (`src/model-catalog.mjs`,
  `ModelCatalog.list({ refresh: true })`), то есть именно то, что Pi реально отдаёт;
- остатки — живой запрос к балансовым эндпоинтам площадок (`scripts/provider-balances.mjs`).

## Сводная таблица

| Провайдер | Доступ | Моделей | Остаток | Чем подтверждён остаток |
| --- | --- | --- | --- | --- |
| DeepSeek | API-ключ `DEEPSEEK_API_KEY` | 4 в каталоге, **1 в конфиге** | **36.78 CNY + 2.00 USD** | `GET api.deepseek.com/user/balance` |
| RouterAI | API-ключ `ROUTERAI_API_KEY` | 3 в конфиге, **497 в каталоге** | **2097.61 ₽** (credits) | `GET routerai.ru/api/v1/credits` |
| WormSoft | API-ключ `WORMSOFT_API_KEY` | 10 в конфиге, **39 в API** | **остаток кредитов подписки** | `GET /api/gpt/subscription-limit` + публичные параметры тарифа |
| Clodex | API-ключ `CLODEX_API_KEY` | 9 | нет данных | `/api/user/self` → 401, нужен access token ЛК |
| Hugging Face | токен `HF_TOKEN` (fine-grained) | 75 | нет данных | `/api/whoami-v2`: `isPro: false`, баланс только в кабинете |
| Google (Gemini) | API-ключ `GEMINI_API_KEY` | 22 | нет данных | баланс живёт в Google Cloud Billing, не в API-ключе |
| OpenAI Codex | OAuth, подписка ChatGPT | 8 (5 отвечают) | не деньги | в access-токене `chatgpt_plan_type: "plus"` |
| ~~GitHub Copilot~~ | ~~OAuth, `sku=free_limited_copilot`~~ | 0 (было 28) | — | **удалён 2026-09-20** (403 `trade_restricted_country`) |

Итого облачных моделей в каталоге: 131. Локально (`llama.cpp`) — ещё 6
профилей, в таблицу не входят. Всего Pi отдаёт 137 моделей.

## Модели по провайдерам

### DeepSeek — оставлен только `deepseek-flash`

В `~/.pi/agent/models.json` провайдер `deepseek` объявлял четыре модели:
`deepseek-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp`,
`deepseek-v4.1-flash-expires-on-0910`. Две последние отсутствуют в
`GET api.deepseek.com/models` (там только `deepseek-flash` и `deepseek-v4-pro`),
то есть объявлены впустую. После чистки осталось: `deepseek-flash`.

В каталоге Pi (`GET /api/models`) DeepSeek всё равно даёт 4 id: `deepseek-flash` плюс три
**встроенных определения** из `pi-ai/dist/providers/data/deepseek.json`
(`deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `deepseek-v4-pro`).
Они не в `models.json` и конфигом не убираются — Pi объединяет встроенный каталог
с пользовательским, а не заменяет его. Скрыть их можно только из списка выбора
(`settings.enabledModels`), где у DeepSeek и раньше стоял один `deepseek/deepseek-flash`.

### RouterAI — 3 в конфиге из 497 в каталоге

В `models.json` объявлены только `deepseek/deepseek-v4.1-flash`, `qwen/qwen3.8-27b`,
`z-ai/glm-5.3-flash`, но это не граница доступа: `GET routerai.ru/api/v1/models`
(аутентификация по докам не нужна) отдаёт **497 моделей от 76 вендоров**, и ключ работает
со всеми. Проверено реальными запросами к трём моделям, которых нет в `models.json`:
`anthropic/claude-sonnet-5`, `x-ai/grok-4.6`, `openai/gpt-5.4-mini` — все три ответили `OK`.

Почему Pi показывает только 3: у `routerai` нет авто-подтягиваемого каталога
(в `~/.pi/agent/models-store.json` кеши есть только у `openai-codex`, `google`, `deepseek`,
`huggingface`, `llama.cpp`) — список берётся исключительно из `models.json`.

Крупные вендоры в каталоге: `openai` 75, `qwen` 63, `google` 36, `mistralai` 24,
`deepseek` 16, `z-ai` 16, `anthropic` 15, `minimax` 13, `x-ai` 12, `microsoft` 10,
`bytedance-seed` 9, `perplexity` 9. Кроме текстовых LLM там же картинки
(`recraft`, `black-forest-labs`, `x-ai/grok-imagine-*`), эмбеддинги (`voyageai`,
`google/gemini-embedding-*`), аудио (`deepgram`, `openai/whisper-*`) и видео
(`google/veo-*`, `minimax/hailuo-*`) — то есть 497 — это весь каталог платформы, а не
только чат-модели.

### WormSoft — 10 в конфиге из 39 в API

`anthropic/claude-sonnet-5`, `deepseek/deepseek-v4.1-flash`, `google/gemma4:31b`,
`minimaxai/minimax-m3`, `openai/gpt-5.6-luna`, `openai/gpt-oss:120b`,
`openai/gpt-oss:20b`, `qwen/qwen3.8:27b`, `zai/glm-5.3-flash:NVFP4`, `zai/glm-5.3:NVFP4`

`GET ai.wormsoft.ru/api/gpt/v1/models` (Bearer-ключ) отдаёт 39 моделей — среди них
алиасы `wormsoft/agent|code|vision/low|medium|high`, `kimi/kimi-k3`, `kimi-k2.6`,
`kimi-k2.7-code`, `anthropic/claude-opus-5`, `claude-fable-5.1`, `claude-haiku-4.5`,
`openai/gpt-5.6-sol|terra`, `openai/gpt-6-astra`, `deepseek-ai/deepseek-v4-pro|flash`,
`zai/glm-5.3`, `qwen/qwen3.6:27b`, `nvidia/nemotron-3-ultra`. Живой проверкой
подтверждено, что ключ работает и с теми, которых нет в конфиге:
`kimi/kimi-k3`, `anthropic/claude-opus-5`, `openai/gpt-5.6-sol` — все ответили.

#### Цены (публичный прайс, ключ не нужен)

`GET ai.wormsoft.ru/api/money/token-pricing` → 18 моделей, поля `input`/`output`/`cache`,
по документации — за 1 000 000 токенов (валюту/единицу API не указывает):

| Модель | вход | выход | кэш |
| --- | --- | --- | --- |
| `wormsoft/agent/low`, `wormsoft/code/low` | 0.0005 | 0.005 | 0.00005 |
| `google/gemma4:31b` | 0.004 | 0.05 | 0.0005 |
| `wormsoft/agent/medium`, `wormsoft/code/medium` | 0.03 | 1 | 0.00005 |
| `wormsoft/code/high` | 0.08 | 3 | 0.03 |
| `wormsoft/agent/high` | 1 | 4 | 0.03 |
| `openai/gpt-5.4` | 1 | 4 | 0.03 |
| `openai/gpt-5.4-mini` | 0.012 | 1.2 | 0.01 |
| `openai/gpt-5.5` | 30 | 150 | 2 |
| `zai/glm-5.1` | 1.4 | 4.5 | 0.1 |
| `qwen/qwen3.5-plus`, `qwen/qwen3.6-plus` | 0.04 | 2.5 | 0.02 |
| `qwen/qwen3.5-35b`, `google/gemma4:26b` | 0.0005 | 0.005 | 0.00005 |

Текущий остаток подписки отдаёт авторизованный
`GET /api/gpt/subscription-limit` в исторически опечатанных полях
`subcriptionType` / `subcriptionLimit`. Проверено живым запросом 2026-09-22:
тариф `payed`, остаток 1 402 275 кредитов. Публичные параметры тарифов берутся из
`GET /api/user-connector/subscription-limits`: для `payed` базовый объём
3 000 000 кредитов, окно 14 400 с, 120 запросов / 60 с, 5 параллельных запросов,
4000 ₽ за 30 дней. API не отдаёт точное время следующего сброса, поэтому TaskBridge
его не выдумывает.

⚠ Расхождение: 11 из 18 позиций прайса (`openai/gpt-5.5`, `glm-5.1`, `qwen3.5-plus`…)
в списке `v1/models` не значатся, и наоборот — большинство рабочих моделей
(`claude-opus-5`, `kimi-k3`, `gpt-5.6-sol`) в прайсе отсутствуют. Единицу цены
(кредиты или рубли) API не сообщает, а по тарифам она не сходится: 150 000 кредитов
за 1000 ₽ дают для `gpt-5.4` абсурдно низкую цену. Не проверено, что означает число.

### Clodex — 9

`deepseek-v4.1-flash`, `gemini-3.7-flash`, `gemini-3.8-flash`, `glm-5.3`,
`glm-5.3-flash`, `gpt-5.6-sol`, `gpt-6-astra`, `kimi-k3`, `qwen3.8-flash`

### Hugging Face — 75 (обрезать конфигом нельзя)

Живая проверка роутера (`router.huggingface.co/v1`, токен `HF_TOKEN`):
`deepseek-ai/DeepSeek-V4.1-Flash`, `Qwen/Qwen3.8-27B`, `zai-org/GLM-5.3` — отвечают.
Список формируется не конфигом: 71 модель «прошита» в пакете Pi
(`pi-ai/dist/providers/data/huggingface.json`), остальные добираются удалённым
каталогом/кешем `models-store.json`. Семьи в списке: `deepseek-ai/*`, `google/gemma-*`,
`Qwen/*`, `zai-org/GLM-*`, `moonshotai/Kimi-*`, `MiniMaxAI/MiniMax-*`,
`openai/gpt-oss-*`, `thinkingmachines/Inkling*`, `stepfun-ai/*`, `XiaomiMiMo/*`.
Полный список даёт сама проба Pi (`GET /api/models` у TaskBridge).

Почему «убрать лишнее» в `models.json` не работает (проверено по коду Pi):
`applyModelsJson()` только **добавляет или переопределяет** модели (`upsert`),
удалить встроенные нельзя; настройки вида `disabledProviders`/`hiddenModels` нет
(полный список геттеров `SettingsManager` просмотрен). Заменить список
провайдера целиком может только **расширение Pi** (`applyExtension()` возвращает
ровно `config.models`), либо фильтр на стороне TaskBridge в `GET /api/models`.

Варианты правки (нужен выбор критерия «лишнего»):

1. убрать токен `HF_TOKEN` — провайдер исчезает из каталога целиком;
2. оставить allowlist в `settings.enabledModels` — чистит только список выбора Pi,
   но не выдачу `/api/models`;
3. расширение Pi или фильтр в TaskBridge — единственный способ убрать модели
   из каталога, но это код.

### OpenRouter — провайдер есть, ключа нет

OpenRouter встроен в Pi (`pi-ai/dist/providers/openrouter.js`, базовый URL
`https://openrouter.ai/api/v1`), включается переменной `OPENROUTER_API_KEY` или
OAuth («Sign in with OpenRouter»). На этой машине ключа нет: в `~/.codex`
встречается только шаблон-заглушка `sk-or-v1-xxxx` в старом логе сессии.
Поэтому OpenRouter не появляется в каталоге и повестки в отчёте не имеет;
баланс и модели без ключа не запросить (каталог — только `GET /api/v1/models`).

### Google — 22

`gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`,
`gemini-2.5-computer-use-preview-10-2025`, `gemini-3-flash-preview`,
`gemini-3.1-pro-preview`, `gemini-3.1-pro-preview-customtools`,
`gemini-3.1-flash-lite(-preview|-image)`, `gemini-3.1-flash-live-preview`,
`gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.6-flash`,
`gemini-3.7-flash`, `gemini-3.8-flash`, `gemini-flash-latest`,
`gemini-flash-lite-latest`, `gemma-4-26b-a4b-it`, `gemma-4-31b-it`,
`deep-research-preview-04-2026`, `deep-research-max-preview-04-2026`.

### OpenAI Codex — 8

`gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-luna`,
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-6-astra`

### GitHub Copilot — 28 (провайдер удалён, список исторический)

`claude-*` (haiku-4.5, sonnet-4.6, sonnet-5, opus-4.7, opus-4.8, opus-5, fable-5, fable-5.1),
`gemini-3.5..3.8-flash`, `gpt-5-mini`, `gpt-5.3-codex`, `gpt-5.4(-mini|-nano)`,
`gpt-5.5`, `gpt-5.6-luna|sol|terra`, `gpt-6-astra`, `grok-4.5`, `grok-4.6`,
`kimi-k2.7-code`, `kimi-k3`, `mai-code-1-flash-picker`, `mai-code-1.1-flash`

## Отвечают ли модели (живая проверка)

Проверка 2026-09-20: `pi -p "Reply with exactly: OK" --provider <p> --model <m>`
(`--no-session -nt --no-extensions --no-skills --no-prompt-templates --no-context-files --thinking off`).

### OpenAI Codex — отвечает частично, 5 из 8

| Модель | Ответ |
| --- | --- |
| `gpt-5.5` | OK |
| `gpt-5.6-luna` | OK |
| `gpt-5.6-sol` | OK |
| `gpt-5.6-terra` | OK |
| `gpt-6-astra` | OK |
| `gpt-5.3-codex-spark` | ошибка: `model is not supported when using Codex with a ChatGPT account` |
| `gpt-5.4` | та же ошибка |
| `gpt-5.4-mini` | та же ошибка |

Это не сбой доступа, а расхождение каталога Pi со списком, который принимает
Codex-бэкенд для аккаунта ChatGPT: три модели Pi показывает, а сервер их отвергает.

### GitHub Copilot — не отвечает ни одна

Проверены `gpt-5-mini`, `claude-haiku-4.5`, `grok-4.5` — все три падают одинаково
на обновлении OAuth-токена, ещё до вызова модели:

```
OAuth refresh failed for github-copilot: 403 Forbidden:
"At this time, Copilot is not available in your location.
 You are currently logged in as arnyigor."
notification_id: trade_restricted_country
```

Сохранённый access-токен был просрочен (`exp` = 2026-05-04), а refresh упирался в
географическое ограничение GitHub. То есть 28 моделей провайдера в списке были, но
нерабочие — провайдер удалён (см. выше). `pi auth check --provider github-copilot` при этом говорит `invalid`,
а с `--no-refresh` — `ready` (проверяется только наличие записи, не её валидность).

### GitHub Copilot — удалён 2026-09-20

Раньше провайдер отдавал 28 моделей (`claude-*`, `gemini-3.*-flash`, `gpt-5*`,
`gpt-6-astra`, `grok-4.5|4.6`, `kimi-k2.7-code`, `kimi-k3`, `mai-code-1*`); ни одна не
отвечала по причине из раздела ниже, поэтому креды убраны:

- `~/.pi/agent/auth.json` — блок `github-copilot` удалён
  (бэкап: `auth.json.bak-before-drop-github-copilot-20260920-081315`);
- `~/.pi/agent/settings.json` — из `enabledModels` убран `github-copilot/gpt-5-mini`,
  иначе появлялось предупреждение `No models match pattern`
  (бэкап: `settings.json.bak-before-drop-copilot-model-20260920-081341`).

Проверено после правки: `pi auth check --provider github-copilot` →
`not_ready / credentials_not_configured`; в каталоге Pi провайдера больше нет
(138 моделей против 166), `openai-codex` по-прежнему `ready`.
Вернуть можно из бэкапов или командой `/login github-copilot` в TUI.

## GitHub: где обновляется токен и почему это не помогало

Учётные данные лежат в `~/.pi/agent/auth.json`, блок `github-copilot`:
`refresh` = `ghu_…`, `access` = выданный Copilot-токен, `expires` = 2026-05-04 (просрочен).

Правильный путь обновления — TUI Pi:

- `/login github-copilot` — заново пройти device-code OAuth (аргумент-провайдер
  поддерживается, `/login` без аргумента открывает селектор);
- `/logout` — удалить сохранённые креды (env и `models.json` не затрагивает).

В CLI команды входа нет: `pi auth` умеет только `print-api-key`,
`print-bearer-token`, `check`.

Почему перелогин сам по себе не вернёт Copilot (проверено 2026-09-20):

1. `refresh` у этого провайдера — не refresh-token, а сам GitHub-токен: Pi отправляет
   его в `GET https://api.github.com/copilot_internal/v2/token` и ждёт Copilot-токен.
   Прямой запрос с тем же значением даёт **403 `trade_restricted_country`**
   («Copilot is not available in your location… currently logged in as arnyigor»).
   То есть отказ приходит с сервера по региону, а не из-за протухшего токена.
2. Свежий `/login` выдаст новый `ghu_`-токен, но обмен на Copilot-токен с того же
   IP упрётся в тот же 403.
3. Дополнительно сам `github.com` с этой машины отвечает нестабильно: 6 попыток
   `https://github.com/login/device` → 2×302, 4×таймаут. Device-flow может не дойти
   до конца ещё до шага обмена.

Вывод: обновить запись можно только через `/login github-copilot`, но провайдер оживёт
лишь вместе с сетевым маршрутом и правом аккаунта на Copilot — Pi на это не влияет.
Поэтому 2026-09-20 креды удалены.

## Убрано из конфига (2026-09-20)

Оставлены только те модели, которые провайдер реально принимает.

| Файл | Что сделано | Бэкап |
| --- | --- | --- |
| `~/.pi/agent/models.json` | у `deepseek` оставлен только `deepseek-flash` (было 4) | `models.json.bak-before-prune-20260920-083653` |
| `~/.pi/agent/settings.json` | из `enabledModels` убраны 3 мёртвых записи (23 → 20) | `settings.json.bak-before-prune-models-20260920-083700` |

Из `enabledModels` убраны:

- `openai-codex/gpt-5.4` — каталог её отдаёт, но Codex-бэкенд отвечает
  `not supported when using Codex with a ChatGPT account`;
- `wormsoft/deepseek-ai/deepseek-v4-flash` и `llama.cpp/Qwen3.8-27B-ZB4.00-MIN-v5.1-IQ4_XS` —
  не совпадают ни с одной моделью каталога (давали предупреждение при каждом старте).

Проверка всех остальных записей `enabledModels` на совпадение с каталогом — совпадают;
список моделей в `models.json` сверен с живыми каталогами провайдеров: у wormsoft (10/10),
routerai (3/3) и clodex-openai (9/9) все id на месте, у deepseek — только два из четырёх
(см. выше). Локальные профили `llama.cpp` не трогались.

После правки: `pi -p "hi"` — ни одного предупреждения (до чистки их было два:
`wormsoft/deepseek-ai/deepseek-v4-flash`, `llama.cpp/Qwen3.8-27B-ZB4.00-MIN-v5.1-IQ4_XS`);
`pi -p "..." --provider deepseek --model deepseek-flash` → `OK`.

## Что проверено и чего нет

Проверено запросами (2026-09-20):

- `api.deepseek.com/user/balance` → `is_available: true`, 36.78 CNY + 2.00 USD.
- `routerai.ru/api/v1/credits` → `{"data":{"credits":2097.61...}}`. Валюта в ответе не
  указана, но в документации (`routerai.ru/docs/reference`) цены `GET /v1/models` —
  в рублях (`pricing` + `pricing_units`), и там же — те же единицы для лимитов ключа.
  Пересчёт на 1M токенов даёт правдоподобные рублёвые цены: `deepseek-v4-pro` 64.71 ₽
  вход / 129.43 ₽ выход, `gpt-5.6-sol` 218.91 / 1094.57 ₽ (в долларах это были бы
  абсурдные суммы). Значит `credits` ≈ рубли. `GET /v1/key` показывает расход этого
  ключа: `usage_monthly` 2.34 и уменьшение `credits` на ~0.009 за шесть пробных
  запросов — те же единицы.
- WormSoft: `GET /api/gpt/subscription-limit` с Bearer API-ключом отдаёт тип подписки
  и оставшиеся кредиты; `GET /api/user-connector/subscription-limits` — публичные
  параметры тарифов. Точного `resetAt` API не отдаёт.
- WormSoft, живые вызовы моделей, которых нет в `models.json`: `kimi/kimi-k3`,
  `anthropic/claude-opus-5`, `openai/gpt-5.6-sol` — ответили.
- Hugging Face, живой вызов роутера: `deepseek-ai/DeepSeek-V4.1-Flash`, `Qwen/Qwen3.8-27B`,
  `zai-org/GLM-5.3` — ответили (токен `HF_TOKEN`, fine-grained, `isPro: false`).
- Clodex: `/api/user/self`, `/api/user/dashboard`, `/api/token/` → 401 (нужен access
  token из личного кабинета, `sk-`-ключ там не принимается).
  `/v1/dashboard/billing/subscription` отвечает, но это OpenAI-совместимая заглушка
  (`hard_limit_usd: 1e8`), а не остаток.
- Hugging Face: `/api/whoami-v2` и `/api/billing/usage` (404) — остаток по токену не отдаётся.
- Google: у `GEMINI_API_KEY` нет балансового эндпоинта.

Не проверено:

- остатки Clodex / Hugging Face / Google — доступны только в веб-кабинетах;
- у Copilot проверены 3 модели из 28 — отказ происходит на refresh'е токена, то есть
  до выбора модели, поэтому остальные 25 отдельно не гонялись;
- Clodex в этот прогон не входил (ни цены, ни живые вызовы моделей помимо конфига);
- единица цены WormSoft (числа прайса с тарифами не сходятся);
- 4 из 497 моделей RouterAI — то есть бóльшая часть каталога не вызывалась.

Воспроизведение остатков: `node scripts/provider-balances.mjs` (или `--json`).
