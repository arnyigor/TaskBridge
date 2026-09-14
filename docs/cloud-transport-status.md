# Состояние cloud-транспорта TaskBridge

Дата: 9 сентября 2026. Ветка `feature/cloud-transport` (8 коммитов, **локальная, не запушена**).
Отправная точка: `master` @ `da4122b`.

Документ фиксирует, что сделано и проверено, что не проверено, и что делать дальше.
Инструкции по деплою — [`cloud-deploy-vercel.md`](cloud-deploy-vercel.md),
протокол и гарантии — [`cloud-transport.md`](cloud-transport.md).

---

## 1. Статус одной таблицей

| Область | Состояние |
|---|---|
| Локальный runtime (Pi, задачи, UI) | работает, как раньше; облако — опция |
| Транспорт событий (seq, outbox, replay) | реализован и покрыт тестами |
| Облачный API + PWA | реализованы, тесты на memory/sqlite/postgres-интерфейсе |
| Подтверждения инструментов (approvals) | реализованы end-to-end, опция `approvals.enabled` |
| Ограничение вывода инструментов | реализовано (rolling window + полный лог в артефакте) |
| Модель / thinking по команде | реализовано (API + команды облака) |
| Метрики | реализованы (локально + облако, Prometheus) |
| Автодеплой на Vercel | скрипт готов, **на живом Vercel не запускался** |
| Postgres-адаптер | написан, **на живом сервере не прогонялся** |
| Аудит утечек секретов | работает, встроен в `npm run check` |
| Деплой | **не выполнен**: ни проекта, ни базы |
| Тесты | 188 проходят, 1 пропущен (Postgres live) |

---

## 2. Объём изменений

```text
82 файла, +14 127 / −20 относительно master
29 файлов тестов, 189 тестов (188 pass, 1 skip)
~5 500 строк нового кода облака (src/cloud, src/events, src/domain, cloud/, api/)
зависимости: без новых обязательных (dompurify, marked как были)
optionalDependencies: pg (нужен только для Postgres-хранилища)
engines: node >= 22.13 (node:sqlite, global fetch)
```

Коммиты ветки (от старого к новому):

| Коммит | Содержание |
|---|---|
| `293a1d9` | базовый cloud-транспорт: протокол событий, worker, outbox, облачный API, PWA |
| `146d1f4` | Stage A: approvals, ограничение вывода, model/thinking, метрики, экран настроек, stress-тесты |
| `b149ef9` | Postgres-адаптер, Vercel-конфиг, генератор секретов, гайд по деплою |
| `e10c55f` | автодеплой `npm run cloud:deploy`, модули кредов/плана, подробный гайд |
| `bcded62` | `.vercelignore` + проверка, объяснение CLI vs Git |
| `76a08e4` | аудит утечек (`check:secrets`), режим Git-автодеплоя (`--git`) |
| `2e6bc3d` | `.env*` в `.gitignore`, фикстуры без секретообразных литералов |
| `1c40324` | не требовать `--database-url`, если база уже подключена интеграцией |

---

## 3. Что реализовано

### 3.1 Локальная сторона (`src/`)

| Модуль | Роль |
|---|---|
| `domain/task-event.mjs` | канонический `TaskEvent`, версия протокола |
| `domain/cloud-command.mjs` | типы команд, приоритеты, идемпотентность |
| `domain/machine-state.mjs` | ONLINE/OFFLINE/BUSY по heartbeat |
| `events/event-sequence.mjs` | строго монотонный `seq`, сохраняется между restart'ами |
| `events/event-normalizer.mjs` | Pi RPC → `TaskEvent`, дельты, snapshot'ы, окно вывода |
| `events/event-snapshot.mjs`, `events/event-mux.mjs` | компактные snapshot'ы, coalescing, санитизация |
| `cloud/cloud-config.mjs` | конфиг из `config.json` + env, режимы local-only/cloud/hybrid |
| `cloud/machine-auth.mjs` | bearer и HMAC-подпись машины |
| `cloud/cloud-client.mjs` | HTTP-клиент облака с таймаутами и retry |
| `cloud/sanitize.mjs` | редактирование секретов и путей перед отправкой |
| `cloud/event-buffer.mjs` | батчинг дельт, coalescing, приоритеты, backpressure |
| `cloud/outbox.mjs` | durable очередь (SQLite), восстановление после падения |
| `cloud/event-uploader.mjs` | отправка батчей, ack, повтор, лимиты |
| `cloud/reconnect-manager.mjs` | backoff 1s→30s |
| `cloud/heartbeat.mjs` | heartbeat + reconcile при старте |
| `cloud/command-dispatcher.mjs` | исполнение команд облака локально |
| `cloud/approval-manager.mjs` | жизненный цикл подтверждений, таймауты, fail-closed |
| `cloud/cloud-worker.mjs` | связывает всё вместе, `WAITING_USER`, shutdown |
| `approvals/policy.mjs` | какие tool-вызовы требуют подтверждения |
| `tool-output.mjs` | rolling window и `tailBytes` для больших выводов |
| `metrics.mjs` | счётчики/гейджи/наблюдения + Prometheus-формат |
| `pi-extension/taskbridge-approval.js` | Pi-хук `tool_call`, опрос локального эндпоинта |

### 3.2 Облако (`cloud/`, `api/`)

| Модуль | Роль |
|---|---|
| `cloud/lib/router.mjs` | весь API (человек / машина / публичный health) |
| `cloud/lib/auth.mjs` | пользовательские токены, машинные секреты, владение |
| `cloud/lib/store.mjs` | интерфейс + `MemoryStore` + `SqliteStore` + `resolveStoreTarget` |
| `cloud/lib/store-postgres.mjs` | Postgres-адаптер (для serverless) |
| `cloud/lib/{errors,ids}.mjs` | единый конверт ошибок, идентификаторы |
| `cloud/lib/credentials.mjs` | генерация токенов/секретов |
| `cloud/lib/deploy.mjs` | план деплоя, маскирование секретов, правила «секретных» путей |
| `cloud/lib/upload-set.mjs` | реальный набор файлов для `vercel deploy` |
| `cloud/server.mjs` | локальный хост облака + SSE + retention |
| `cloud/api/index.mjs` | Vercel-функция (общий роутер) |
| `web/*` | единый UI: он же PWA в облаке (раздаётся Vercel из `vercel.json`) |
| `api/index.mjs`, `vercel.json` | энтрипоинт и конфиг Vercel (root = корень репозитория) |

### 3.3 Инструменты и документация

| Файл | Назначение |
|---|---|
| `scripts/cloud-secrets.mjs` | `npm run cloud:secrets` — токены/секреты |
| `scripts/cloud-deploy.mjs` | `npm run cloud:deploy` — link → env → deploy → verify |
| `scripts/check-secrets.mjs` | `npm run check:secrets` — аудит утечек |
| `.vercelignore` | исключает `config.json`, `data/`, `cloud/data/` из CLI-деплоя |
| `docs/cloud-transport.md` | протокол, API, гарантии, ограничения |
| `docs/cloud-deploy-vercel.md` | деплой пошагово, диагностика, ротация |
| `README.md` | обзор, структура, режимы |

### 3.4 Возможности, доступные пользователю

- Задача из телефона → выполняется локальным Pi, события стримятся обратно.
- Переживает закрытие браузера: транскрипт восстанавливается replay'ем по `seq`.
- Переживает падение/офлайн облака: события копятся в outbox, команды ждут.
- STOP, follow-up, compact, смена модели и thinking — из PWA.
- Подтверждения опасных tool-вызовов (`approvals.enabled`) — с телефона.
- Полный лог инструмента по требованию, если он был обрезан.
- Метрики: локально `/api/metrics[?format=prometheus]`, в облаке `/api/metrics`.
- Экран облачных настроек в локальном UI (проверка соединения, сохранение на живую).
- Локальный режим без облака продолжает работать без конфигурации.

---

## 4. Что проверено

| Проверка | Результат |
|---|---|
| `npm run check` (синтаксис + аудит секретов) | ok |
| `npm test` | 188 pass / 1 skip |
| `npm run test:cloud` | ok |
| `npm run stress` | ok, ограниченные прогоны в CI |
| Stress (масштабированный вручную) | 20 000 событий за 4.2 с (≈4 700 ev/s), 245 загрузок, heap +36.8 МБ |
| Большой лог инструмента | 100 МБ → в облако 6.26 МБ, полный лог в артефакте |
| Реальный Pi RPC | `pi --mode rpc -e pi-extension/taskbridge-approval.js` стартует, хук грузится |
| Локальный хост облака | PWA, `/api/health` (`store`, `durable`), SSE |
| Аудит секретов | 128 файлов в наборе деплоя, утечек нет; фикстура с утечкой ловится |
| E2E-тест | задача из облака исполняется локально через Pi RPC, события возвращаются, STOP работает |

Покрытие по областям: домен и события, нормализация/snapshot'ы, буфер и outbox,
uploader и reconnect, heartbeat, dispatcher, approvals (политика, менеджер,
маршрутизация, сквозной сценарий), ограничение вывода и его догрузка,
model/thinking, метрики, настройки облака, API облака (auth, очередь офлайн,
scope машины, дедупликация, replay, reconcile), reducer PWA, deploy-план,
аудит утечек.

---

## 5. Что НЕ проверено

| Пункт | Почему | Как проверить |
|---|---|---|
| Реальный деплой на Vercel | нужен аккаунт/решение по базе | `npm run cloud:deploy -- --project … --dry-run`, затем без `--dry-run` |
| `vercel env add` через stdin | нужен живой проект | после деплоя: `vercel env ls production` |
| Postgres-адаптер на живом сервере | локально нет Docker/Postgres | `$env:TASKBRIDGE_TEST_DATABASE_URL="postgres://…"; npm run test:postgres` |
| Git-автодеплой | ветка не запушена | пуш ветки/мерж в `main` + `--git` |
| Approvals с живой моделью | нужен реальный tool-вызов | включить `approvals.enabled`, дать опасную команду |
| PWA на телефоне | нужен деплой | чек-лист §6 гайда |
| Долгий soak (30+ мин) | включается вручную | `$env:TASKBRIDGE_STRESS_SECONDS="1800"; npm run stress` |

---

## 6. Состояние деплоя (на 9 сентября 2026)

- В аккаунте Vercel (`arnyigor-8318`) проектов TaskBridge нет: `vercel project ls` показывает только `aipromptsapi`.
- Локально нет `.vercel/project.json` → проект не привязан.
- В `config.json` нет блока `cloud` → локальный транспорт не включён.
- База данных не выбрана. **Neon заблокирован** (console.neon.tech → 403 с этой сети).
  Проверена доступность альтернатив: supabase.com ✅, vercel.com ✅,
  console.upstash.com ✅, timeweb.cloud ✅, console.yandex.cloud ✅, aiven.io ✅.
- Ветка `feature/cloud-transport` не запушена; `master` опережает `origin/master` на 7 коммитов (не связано с облаком).

Следствие: ошибки `DEPLOYMENT_NOT_FOUND` и `{"error":"Not found","code":"NOT_FOUND"}`
при открытии `taskbridge-cloud.vercel.app` — это ответы Vercel на несуществующий
деплой (у TaskBridge конверт другой: `{"error":{"code":…}}`). Деплоя пока нет.

### Перепроверка 14 сентября 2026 (мобильный интернет)

Через мобильный интернет (сотовая сеть, не Wi‑Fi) TaskBridge **сейчас не
доступен**. Проверено на работающем локальном сервере 0.9.5-dev (`e6370c7`):

- `GET /debug/cloud` → `{"enabled": false, "reason": "Cloud transport is disabled
  by configuration."}`: в `config.json` блок `cloud` есть, но `enabled: false`,
  поэтому машина не открывает ни одного исходящего соединения.
- Деплой на Vercel существует и не тот. Проект `arnyigors-projects/taskbridge-cloud`
  (`cloud/.vercel/project.json`), 3 production-сборки от 10 сентября, все `Ready`,
  алиас `https://taskbridge-cloud.vercel.app` отдаёт статику и функции
  **старого cloud bridge** (`190cf49`): `api/login`, `api/bridge/commands-ack`,
  `api/bridge/commands-pull`, `api/events`, `api/events-ack` (проверено `vercel
  inspect`). Все адреса текущего транспорта — `/api/health`, `/api/bridge/heartbeat`,
  `/api/bridge/commands`, `/api/bridge/reconcile`, `/api/relay` — возвращают
  штатную 404 Vercel. Включить облако на этот адрес бессмысленно: heartbeat уйдёт
  в 404.
- Спаренный 11 сентября телефон (`data/trusted-devices.json`, `dev-afa0746257f96e50`)
  имеет `lastSeenAt: null` — до машины он так и не дошёл.
- Работает по-прежнему только локальная сеть: `http://192.168.1.212:8787` и
  `https://192.168.1.212:8443` (это же отдаёт `GET /api/info` → `addresses`).

Чтобы мобильный интернет заработал, нужно (1) задеплоить текущий код из корня
репозитория (`vercel.json`: `outputDirectory: web` + функция `api/index.mjs`;
`npm run cloud:deploy -- --project taskbridge-cloud --database-url "postgres://…"
--write-config`), (2) проверить `/api/health` → `store: postgres`, `durable: true`,
и включить `cloud.enabled` + `realtime` с адресом и секретом машины,
(3) спарить телефон QR-кодом (`POST /api/cloud/pair`). Альтернатива без Vercel и
Postgres — сценарий C ниже (`npm run cloud` на ПК + Cloudflare Tunnel).

### Подключение без QR и «по паролю» (сверено с кодом 14.09.2026)

Пароля в текущем коде нет ни на одном из входов:

| Вход | Что удостоверяет телефон | Где задаётся |
|---|---|---|
| LAN (`http://192.168.1.212:8787`) | сейчас **ничего**: `server.auth.enabled: false`, `GET /api/auth` → `{"enabled": false}` — ни пароля, ни кода, ни QR | `config.json` → `server.auth` |
| LAN с включённой авторизацией | **8-значный код**, не пароль: ПК показывает его в `GET /api/auth/pairing` (только с localhost, иначе 403), телефон шлёт `POST /api/auth/pair` | `src/auth.mjs` (`pairing`, `pair`) |
| Облако / PWA | **device token** `v1.<payload>.<HMAC-SHA256>`, подписан секретом машины, TTL 30 дней — выдают при паринге | `src/cloud/device-token.mjs` |
| Старый деплой на Vercel | пароль (`/api/login` → 401) — это легаси `190cf49`, текущий код его не понимает (см. выше) | — |

Без QR подключиться можно двумя способами:

* **A. Туннель прямо на ПК (обычно самый быстрый, облако и база не нужны).**
  `cloudflared tunnel --url http://127.0.0.1:8787` (или ngrok) → открыть выданный
  `https://…` на телефоне. Проверено по коду, не запуском (на машине туннеля нет:
  `cloudflared`/`ngrok` не в PATH, есть `winget`): страница приходит с того же
  origin, что и API, а `selectTransport` (`web/transport.mjs`) без
  `__TASKBRIDGE_CLOUD__` выбирает локальный транспорт → обычный HTTP+SSE, как в
  LAN; `checkOrigin` (`src/auth.mjs`) сравнивает `Origin` с `Host`, а туннель
  сохраняет `Host`, так что проверка проходит. Обязательно вместе с
  `server.auth.enabled: true` — иначе ссылка равна полному доступу к Pi, и код
  (8 цифр) придётся смотреть на самом ПК: `GET /api/auth/pairing` отвечает 403 не
  с localhost.
* **B. Ссылку паринга вместо QR.** В облачном деплое QR — только картинка: рядом
  лежит `#cloudPairLink` и кнопка «Скопировать ссылку». Ссылку
  `<cloud>/pair#m=…&t=…&r=wss://…` можно послать себе в мессенджер и открыть на
  телефоне — сканировать нечего. Упирается в то же: облако не задеплоено (§6).

### Решение 14 сентября 2026: пока только локальная сеть (Wi‑Fi)

На этом этапе работаем **только по локальной сети**. Облако и туннели отложены: их
первый реальный шаг упирается в аккаунт/домен, а телефонная PWA ходит на релей
только по WebSocket, который из доступных быстрых туннелей стабильно держит лишь
ngrok (проверки — в разделах выше).

* `config.json` → `cloud.enabled: false`; применено на живом сервере через
  `POST /api/cloud/config` — сразу, без перезапуска: `GET /debug/cloud` →
  `{"enabled": false, "reason": "Cloud transport is disabled by configuration."}`.
  Адрес и секрет машины в конфиге оставлены, транспорт просто не поднимается —
  машина больше не стучится в мёртвый адрес туннеля.
* Рабочие адреса — только LAN: `http://192.168.1.212:8787` и
  `https://192.168.1.212:8443` (то же в `GET /api/info` → `addresses`).
  `server.auth.enabled: false`, поэтому телефону достаточно открыть адрес по Wi‑Fi:
  ни 8-значного кода, ни QR, ни пароля.
* Код облака (`cloud/`, `src/cloud/`), деплой-скрипт и `scripts/cloud-local.mjs`
  (сценарий C: облако на ПК + туннель) **не удалялись** — включатся позже, когда
  появится публичный адрес.

---

## 7. Известные ограничения

1. **Нет WebSocket/SSE на Vercel** — клиент опрашивает (1.5 с при активной задаче).
   Корректность обеспечивают durable-события и replay; SSE есть на локальном хосте облака.
2. **Postgres-адаптер не прогнан на живом сервере** (см. §5).
3. **HMAC в Vercel-адаптере** пересобирает тело из `req.body`; для строгой проверки
   байтов — bearer-режим.
4. **Approvals — опция**: нужен `approvals.enabled` и передача расширения Pi через `--extension`.
5. **Долгий soak** запускается вручную.
6. **Нет push-уведомлений** и мультипользовательского онбординга.
7. **Локальные кнопки модели/thinking** в UI не добавлены (API и облачные команды есть).
8. **CLI-деплой требует `.vercelignore`**: `vercel deploy` не читает `.gitignore`.

---

## 8. Что дальше

### Сценарий A — управлять ПК из любой точки (нужна база)
1. База: Vercel Marketplace (Neon) или Supabase (`--database-url`).
2. `npm run cloud:deploy -- --project taskbridge-cloud --database-url "…" --write-config`.
3. Проверить `/api/health` → `store: postgres`, `durable: true`; `/debug/cloud` → `connected: true`.
4. Прогнать чек-лист §6 гайда с телефона.

### Сценарий B — только домашняя сеть (база не нужна)
Облако не включать. Локальный UI и LAN-доступ работают по умолчанию, ничего создавать не нужно.
**Это вариант, выбранный на сейчас** — см. «Решение 14 сентября 2026» в §6.

### Сценарий C — публичный доступ без Vercel и без Postgres
Запустить `npm run cloud` на своей машине (SQLite) и открыть наружу через Cloudflare Tunnel.
Плюс: нет внешней базы. Минус: выключенный ПК = нет облака, задачи с телефона не ставятся в очередь.

### Продуктовые задачи (после деплоя)
1. Кнопки модели/thinking в локальном UI (API готов).
2. Push-уведомления в PWA.
3. HMAC с точными байтами тела в Vercel-адаптере.
4. WebSocket/SSE fast path — последним, это оптимизация поверх работающего replay.
5. Дорожная карта README: `ClaudeCodeRunner`, `CodexRunner`, KMP Android-клиент.

---

## 9. Как проверить локально

```powershell
npm run check                       # синтаксис + аудит утечек секретов
npm test                            # 188 pass, 1 skip
npm run cloud                       # облако на 127.0.0.1:8788 (sqlite в cloud/data/)
npm run cloud:secrets               # посмотреть, какие креды будут созданы
npm run cloud:deploy -- --project taskbridge-cloud --dry-run   # план деплоя
npm run stress                      # ограниченный стресс-прогон
```
