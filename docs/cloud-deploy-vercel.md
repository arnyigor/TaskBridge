# Деплой облачного транспорта TaskBridge на Vercel

Пошаговая инструкция: от пустого аккаунта Vercel до работающего телефона.
Отдельно описан **автоматический путь** (`npm run cloud:deploy`) и **ручной**
(через дашборд), чтобы можно было сделать любым способом и понять, что именно
происходит.

Локальный TaskBridge остаётся единственным исполнителем: Vercel — транспорт,
аутентификация и durable-хранилище событий. Если Vercel лежит, задачи на машине
продолжают выполняться, а события ждут в локальном outbox.

```text
Телефон / PWA ──HTTPS──► Vercel (API + Postgres) ──► команды
                              ▲                         │
                        события (батчи)                 ▼
                              └──── TaskBridge (исходящие соединения) ──► Pi
```

---

## 0. Что понадобится

### Нужен ли GitHub-проект?

Нет, не обязателен. У Vercel два независимых способа деплоя:

| | Git-интеграция | CLI (`vercel deploy`) |
|---|---|---|
| Что нужно | репозиторий на GitHub/GitLab/Bitbucket | ничего, кроме локальной папки |
| Как попадает код | Vercel клонирует репозиторий | CLI загружает каталог целиком |
| Автодеплой на `git push` | да | нет, деплой запускается вручную |
| Ветка | деплоится ветка (production branch → production) | текущее рабочее дерево, ветка не важна |
| Секреты локальной машины | не могут уехать случайно | **могут**, если нет `.vercelignore` (см. ниже) |

`npm run cloud:deploy` использует **CLI**: он создаёт проект в вашем аккаунте
(`vercel link --yes --project <name>`), пушит env-переменные и деплоит текущий
каталог. Git для этого не нужен, и ветку `feature/cloud-transport` пушить не
обязательно.

Что выбрать:

* **только CLI** — быстрее всего проверить, ничего не публикуя в GitHub;
* **Git-интеграция** — если хотите автодеплой по push (тогда: импорт репозитория
  в дашборде, Root Directory = корень репозитория, дальше шаги 2.4–2.6 ниже;
  скрипт после этого всё равно пригодится для генерации кредов и env-переменных);
* **оба** — нормально: проект один и тот же, CLI-деплой создаёт новую
  production-сборку поверх Git-овой.

> Если вы уже импортировали репозиторий в дашборде, не создавайте второй проект:
> запустите `vercel link --yes --project <существующее-имя>` (или просто
> `npm run cloud:deploy -- --project <существующее-имя> …`) — скрипт привяжется к
> нему и обновит env-переменные.

### Важно про CLI: `.vercelignore`

`vercel deploy` загружает рабочий каталог и **не читает `.gitignore`**. В репозитории
есть `.vercelignore`, который исключает `config.json` (секрет машины), `data/`,
`artifacts/` и `cloud/data/` (база задач). Не удаляйте эти строки — иначе секрет и
локальная история задач уедут в деплой. Скрипт деплоя проверяет файл и откажется
работать, если он пропал или обеднел.

### Таблица требований

| Что | Зачем | Проверка |
|---|---|---|
| Node.js ≥ 22.13 | локальный runtime и скрипты | `node -v` |
| Аккаунт Vercel | хостинг API + PWA | — |
| Vercel CLI ≥ 39 | автодеплой | `vercel --version` |
| Postgres | **обязательно**: файловая система на Vercel эфемерная | Vercel Postgres / Neon |
| Этот репозиторий | деплоится как есть | `npm test` |

Установка CLI и вход (один раз):

```powershell
npm install -g vercel
vercel login
vercel whoami          # должно вывести ваш логин
```

> Без Postgres деплой формально поднимется, но `POST /api/tasks` будет терять
> задачи после следующего вызова функции. Скрипт деплоя считает это ошибкой и
> отказывается деплоить без `--database-url` (обойти: `--allow-memory-store`).

---

## 1. Автоматический путь: `npm run cloud:deploy`

### 1.1 Создать базу

Вариант A — дашборд: **Vercel → Storage → Create Database → Postgres** (или Neon).
После подключения к проекту Vercel сам добавит `POSTGRES_URL` в переменные.

Вариант B — внешний Neon/Supabase: скопируйте connection string вида
`postgres://user:pass@host/db?sslmode=require`.

Вариант C — базы ещё нет, а хочется одним запуском: скрипт умеет создать
проект и задеплоить, но **не** умеет создавать Postgres (CLI не устанавливает
Marketplace-интеграции неинтерактивно). Порядок такой: сначала деплой с
`--allow-memory-store`, потом в дашборде подключить Postgres, потом повторный
запуск с `--database-env POSTGRES_URL`.

### 1.2 Запустить деплой

```powershell
# посмотреть, что будет сделано, ничего не меняя:
npm run cloud:deploy -- --project taskbridge-cloud --database-url "postgres://..." --dry-run

# выполнить:
npm run cloud:deploy -- --project taskbridge-cloud --database-url "postgres://..."
```

Если база уже подключена к проекту (вариант A), URL передавать не нужно:

```powershell
npm run cloud:deploy -- --project taskbridge-cloud --database-env POSTGRES_URL
```

Чтобы сразу прописать локальный `config.json`:

```powershell
npm run cloud:deploy -- --project taskbridge-cloud --database-env POSTGRES_URL --write-config
```

### 1.3 Что скрипт делает по шагам

1. Проверяет Node ≥ 22.13, наличие Vercel CLI и `vercel whoami` (иначе — понятная
   ошибка, а не падение на середине).
2. Генерирует свежие креды: user token (`tb_user_…`), machine secret
   (`tb_machine_…`), machine id (по умолчанию `home-pc-XXXX`).
3. `vercel link --yes --project <name>` — привязывает каталог к проекту.
4. `vercel env add NAME production --force` для `TASKBRIDGE_CLOUD_USER_TOKEN`,
   `TASKBRIDGE_CLOUD_USER_ID`, `TASKBRIDGE_CLOUD_MACHINES` (+ `POSTGRES_URL`, если
   передан). Значения идут **через stdin**, в командной строке секретов нет.
5. `vercel deploy --prod --yes`.
6. `GET /api/health` с ретраями → печатает `store` и `durable`. Если вернулся
   `memory`, скрипт явно предупреждает, что состояние не переживёт следующий
   вызов функции.
7. `GET /api/machines` с user token → проверяет, что токен реально принят.
8. Печатает готовый блок `cloud` для `config.json` (или пишет его при
   `--write-config`, с бэкапом `config.json.bak-<timestamp>`).

### 1.4 Флаги

| Флаг | Значение |
|---|---|
| `--project <name>` | имя Vercel-проекта (создастся, если нет) |
| `--database-url <url>` | строка Postgres → ставит `POSTGRES_URL` |
| `--database-env <NAME>` | проверить, что переменная уже есть в проекте |
| `--allow-memory-store` | разрешить деплой без durable-хранилища (демо) |
| `--write-config` | прописать `cloud` в `config.json` (с бэкапом) |
| `--url <https://…>` | свой домен/алиас вместо `*.vercel.app` |
| `--id`, `--name`, `--owner`, `--user` | machine id, отображаемое имя, owner id, e-mail |
| `--scope`, `--token` | Vercel team/токен (или env `VERCEL_TOKEN`) |
| `--environment` | `production` (по умолчанию) / `preview` |
| `--dry-run` | только показать команды |
| `--skip-verify` | не проверять health (не рекомендуется) |
| `--json` | машинный вывод в конце |

### 1.5 Ожидаемый вывод (сокращённо)

```text
TaskBridge cloud → Vercel
─────────────────────────
    node 24.16.0, Vercel CLI 46.0.1
    logged in as you

[1/6] Link this directory to Vercel project "taskbridge-cloud"
[2/6] Set TASKBRIDGE_CLOUD_USER_TOKEN (production)
...
[6/6] Deploy to production
    https://taskbridge-cloud.vercel.app

[7/7] Verifying https://taskbridge-cloud.vercel.app/api/health
    ok — store: postgres
    token check: accepted

─────────────────────────
Deployed: https://taskbridge-cloud.vercel.app
Health:   ok — store: postgres
...
```

---

## 2. Ручной путь (дашборд / Git-интеграция)

Этот путь нужен, если вы хотите автодеплой по `git push`. Он же — способ сделать
всё руками без скрипта.

0. Запушьте ветку в GitHub (для production-деплоя она должна быть основной веткой
   проекта или смержена в неё).
1. **Import Project** → выберите репозиторий.
2. **Root Directory: корень репозитория** (не `cloud/`). Роутер импортирует
   общие протокольные модули из `src/domain/`, они должны попасть в сборку.
3. **Framework Preset: Other**, Build Command — пусто, Output Directory берётся
   из `vercel.json` (`cloud/web`). Install Command по умолчанию (`npm install`)
   подтянет `pg` из `optionalDependencies`.
4. **Storage → Create Database → Postgres** и подключить к проекту (даст
   `POSTGRES_URL`). Альтернатива: вручную добавить `POSTGRES_URL` от Neon.
5. **Settings → Environment Variables** (Production и Preview):

```env
TASKBRIDGE_CLOUD_USER_TOKEN=tb_user_...
TASKBRIDGE_CLOUD_USER_ID=owner
TASKBRIDGE_CLOUD_MACHINES=[{"id":"home-pc-xxxx","secret":"tb_machine_...","ownerId":"owner","displayName":"DESKTOP"}]
POSTGRES_URL=postgres://...
```

6. **Deploy** → проверка:

```powershell
curl https://<project>.vercel.app/api/health
# {"status":"ok","protocolVersion":1,"machines":0,"store":"postgres","durable":true}
```

Если `"store":"memory"` — `POSTGRES_URL` не подхватился (проверьте имя
переменной и что деплой был после её добавления).

Креды можно получить и без деплоя:

```powershell
npm run cloud:secrets -- --url https://<project>.vercel.app
```

---

## 3. Секреты: как устроены и как менять

| Секрет | Кто использует | Где хранится |
|---|---|---|
| `TASKBRIDGE_CLOUD_USER_TOKEN` | PWA/телефон | Vercel env; вводится в PWA вручную |
| `TASKBRIDGE_CLOUD_MACHINES[].secret` | машина (HMAC/bearer) | Vercel env + локальный `config.json` |
| `POSTGRES_URL` | функция | Vercel env |

Правила:

* секреты **не коммитятся**: `config.json` уже в `.gitignore`;
* скрипты печатают секреты только в stdout, никуда не пишут;
* машин может быть несколько — просто добавьте элементы в JSON-массив
  `TASKBRIDGE_CLOUD_MACHINES`;
* **ротация**: `npm run cloud:deploy -- --project <name> --database-env POSTGRES_URL`
  (генерирует новые креды и обновляет env), затем обновите секрет в локальном
  `config.json` и перезапустите TaskBridge. Старый секрет перестаёт работать
  сразу после деплоя;
* отозвать только машину: удалите её элемент из `TASKBRIDGE_CLOUD_MACHINES` и
  передеплойте (`vercel deploy --prod`).

---

## 4. Настроить эту машину

Три равнозначных способа.

**A. UI (проще всего):** TaskBridge → кнопка **☁** → адрес
`https://<project>.vercel.app`, machine id и secret → **Проверить соединение** →
**Сохранить**. Перезапуск не нужен, применяется на живую.

**B. `config.json`:**

```jsonc
{
  "cloud": {
    "enabled": true,
    "url": "https://<project>.vercel.app",
    "machineId": "home-pc-xxxx",
    "machineSecret": "tb_machine_...",
    "machineDisplayName": "DESKTOP"
  }
}
```

**C. Переменные окружения** (имеют приоритет над `config.json`):

```powershell
$env:TASKBRIDGE_CLOUD_ENABLED="1"
$env:TASKBRIDGE_CLOUD_URL="https://<project>.vercel.app"
$env:TASKBRIDGE_MACHINE_ID="home-pc-xxxx"
$env:TASKBRIDGE_MACHINE_SECRET="tb_machine_..."
```

Затем перезапуск (`start.cmd`). Проверка: `http://127.0.0.1:8787/debug/cloud` →
`"connected": true`, `"lastHeartbeatAt"` свежий.

Важно: **машина должна хотя бы раз отправить heartbeat** — иначе облако ещё не
знает её и на создание задачи ответит `MACHINE_NOT_FOUND`. Это происходит
автоматически в течение ~20 с после старта.

---

## 5. Телефон (PWA)

1. Откройте `https://<project>.vercel.app`.
2. Вставьте user token в поле **Access token**.
3. Браузер → «Добавить на главный экран». Токен сохраняется локально, работает
   офлайн-оболочка; данные всегда с сервера.
4. Раздел **Machines** покажет вашу машину со статусом `ONLINE` (или `OFFLINE`,
   если heartbeat старше 60 с).
5. Создайте задачу: проект и промпт. Дальше — стриминг событий, tool-карточки,
   STOP, follow-up, compact, смена модели/thinking, запросы подтверждений.

---

## 6. Приёмка: чек-лист

| # | Проверка | Ожидаемо |
|---|---|---|
| 1 | `curl .../api/health` | `status: ok`, `store: postgres`, `durable: true` |
| 2 | `curl .../api/machines -H "Authorization: Bearer <token>"` | ваша машина, `status: ONLINE` |
| 3 | `/debug/cloud` локально | `connected: true` |
| 4 | Задача из PWA | стартует локально, события идут в PWA |
| 5 | Закрыть браузер на середине задачи, открыть снова | транскрипт восстановлен (replay по `seq`) |
| 6 | Отключить сеть на машине на минуту | Pi продолжает работу; после возврата бэклог уезжает |
| 7 | STOP из PWA | локальная задача прервана |
| 8 | `approvals.enabled = true`, опасный tool | карточка подтверждения в PWA, ответ доходит |

Полезные команды:

```powershell
npm run test:cloud                      # тесты облака на memory + sqlite
$env:TASKBRIDGE_TEST_DATABASE_URL="postgres://..." ; npm run test:postgres
curl https://<project>.vercel.app/api/metrics -H "Authorization: Bearer <token>"
vercel logs <deployment-url>
```

---

## 7. Диагностика

| Симптом | Причина | Что делать |
|---|---|---|
| `/api/health` → `store: memory` | `POSTGRES_URL` не задан/не тот | добавить БД, передеплой |
| `401 UNAUTHORIZED` в PWA | неверный user token | взять `TASKBRIDGE_CLOUD_USER_TOKEN`, вставить заново |
| `404` на `/api/...` | Root Directory указан как `cloud/` | поставить корень репозитория |
| PWA открывается, но `/api/*` 404 | статика есть, функция не собралась | проверить, что `api/index.mjs` попал в деплой (Root Directory) |
| `MACHINE_NOT_FOUND` при создании задачи | машина ни разу не отправила heartbeat | проверить `/debug/cloud`, сеть, `machineId` |
| `MACHINE_OFFLINE` | heartbeat старше 60 с | задача всё равно ставится в очередь (`PENDING`) |
| Машина `OFFLINE` постоянно | неверный secret / нет исходящего HTTPS | логи локального процесса, `TASKBRIDGE_CLOUD_AUTH_MODE` |
| Дубли событий | повторная отправка после таймаута | норма: дедуп по `(taskId, seq)` |
| События идут с задержкой | polling 1.5 с (нет SSE на Vercel) | ожидаемо; локальный хост облака даёт SSE |
| Первый запрос ~1 с | cold start | ожидаемо, heartbeat держит функцию тёплой |
| Approval не появляется | расширение не подключено | `approvals.enabled = true`, Pi получает `--extension pi-extension/taskbridge-approval.js` |
| `vercel deploy` пишет «No URL parsed» | нестандартный вывод CLI | `vercel ls`, затем `--url https://...` |

---

## 8. Ограничения

* Нет WebSocket/SSE на Vercel: клиент опрашивает (1.5 с при активной задаче).
  Корректность обеспечивают durable-события + replay, а не транспорт.
* `maxDuration: 30` в `vercel.json` (Vercel сейчас допускает до 300 с при Fluid
  compute). Ни один запрос не держится за задачу — это запас, а не потребность.
* Postgres-адаптер написан под тот же интерфейс, что memory/sqlite, и покрыт
  `tests/cloud-postgres.test.mjs`, но **на живом сервере в этом репозитории не
  прогонялся** (локально не было Docker/Postgres). Прогоните один раз:

```powershell
$env:TASKBRIDGE_TEST_DATABASE_URL="postgres://..." ; npm run test:postgres
```

* HMAC-режим в Vercel-адаптере пересобирает тело из `req.body`, поэтому при
  строгой проверке байтов используйте bearer-режим.
* Нет push-уведомлений, нет мультипользовательского онбординга.

---

## 9. Все переменные окружения

**Облако (Vercel):**

| Переменная | Обяз. | Значение |
|---|---|---|
| `TASKBRIDGE_CLOUD_USER_TOKEN` | да | токен для PWA |
| `TASKBRIDGE_CLOUD_USER_ID` | нет | владелец (по умолчанию `owner`) |
| `TASKBRIDGE_CLOUD_USER_EMAIL` | нет | информационно |
| `TASKBRIDGE_CLOUD_MACHINES` | да | JSON-массив `{id,secret,ownerId,displayName,authMode}` |
| `POSTGRES_URL` / `DATABASE_URL` / `TASKBRIDGE_CLOUD_STORE` | да | строка Postgres (иначе memory) |
| `TASKBRIDGE_CLOUD_USERS` | нет | JSON-массив пользователей вместо одиночного токена |

**Машина (локально):**

| Переменная | Значение |
|---|---|
| `TASKBRIDGE_CLOUD_ENABLED` | включить транспорт |
| `TASKBRIDGE_CLOUD_URL` | адрес облака |
| `TASKBRIDGE_MACHINE_ID`, `TASKBRIDGE_MACHINE_SECRET` | креды машины |
| `TASKBRIDGE_CLOUD_AUTH_MODE` | `bearer` (по умолчанию) / `hmac` |
| `TASKBRIDGE_EVENT_FLUSH_MS`, `TASKBRIDGE_EVENT_BATCH_MAX`, `TASKBRIDGE_EVENT_BATCH_MAX_KB` | батчинг событий |
| `TASKBRIDGE_HEARTBEAT_SECONDS`, `TASKBRIDGE_IDLE_POLL_SECONDS`, `TASKBRIDGE_ACTIVE_POLL_SECONDS` | ритм связи |
| `TASKBRIDGE_MAX_OUTBOX_MB` | предел локальной очереди |
| `TASKBRIDGE_CLOUD_REDACT_PATHS` | что вырезать из событий |
| `TASKBRIDGE_APPROVALS_ENABLED`, `TASKBRIDGE_APPROVAL_TIMEOUT_MINUTES`, `TASKBRIDGE_APPROVAL_TIMEOUT_POLICY`, `TASKBRIDGE_APPROVAL_FAILSAFE` | подтверждения |
| `TASKBRIDGE_TOOL_OUTPUT_*` | границы вывода инструментов |

Полное описание протокола и гарантий — [`docs/cloud-transport.md`](cloud-transport.md).

---

## 10. Что проверено, а что нет

**Проверено в этом репозитории:**

* `npm run check`, `npm test` (174 теста), `npm run test:cloud`, `npm run stress`;
* `cloud/lib/deploy.mjs` и `cloud/lib/credentials.mjs` — покрыты
  `tests/cloud-deploy.test.mjs` (план деплоя, маскирование секретов, разбор URL,
  детект `memory`-хранилища, слияние `config.json`);
* `npm run cloud:deploy -- --dry-run` — печатает корректный план и блокирует
  деплой без Postgres;
* локальный хост облака (`npm run cloud`) — PWA, `/api/health` со `store`/`durable`;
* `vercel --version`, `vercel link/env add/deploy/whoami` существуют в CLI 46.0.1
  (по `--help`).

**Не проверено здесь (нужен ваш аккаунт):**

* Git-интеграция: в этом репозитории ветка `feature/cloud-transport` не запушена,
  поэтому автодеплой по push не проверялся — CLI-путь проверен в режиме `--dry-run`;

* фактическая запись env-переменных через stdin и реальный деплой — проверьте
  `vercel env ls production` и `vercel ls` после первого запуска;
* Postgres-адаптер на живом сервере (нет локального Postgres) — прогоните
  `TASKBRIDGE_TEST_DATABASE_URL=postgres://… npm run test:postgres`;
* создание Postgres автоматически: CLI не умеет ставить Marketplace-интеграции
  неинтерактивно, поэтому БД создаётся в дашборде (или берётся Neon-URL).
