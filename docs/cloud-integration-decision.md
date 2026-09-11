# Решение об интеграции: какой cloud-вариант остаётся

Дата: 11 сентября 2026. Выполняется пункт этапа 0 ТЗ v3
([`TaskBridge_TZ_v3.md`](TaskBridge_TZ_v3.md) §4): «основной cloud-вариант,
причины, переносимые возможности второй реализации и миграция настроек».

Ветка: `merge/cloud-transport-master` (слияние `master` в
`feature/cloud-transport`). `master` и `feature/cloud-transport` не изменяются.

## 1. Что столкнулось

После общей базы `da4122b` облако было сделано дважды и независимо:

| | `master` (`190cf49`) | `feature/cloud-transport` (`293a1d9`…`2477b73`) |
|---|---|---|
| Транспорт | Vercel Queues + OIDC, serverless-функции по маршруту | свой протокол: durable events, `seq`, replay, heartbeat, polling команд |
| Облачная служба | `cloud/api/*` (Root Directory = `cloud`), `cloud/public/*` | `cloud/server.mjs` + `cloud/api/index.mjs` + общий `web/` (Root Directory = корень) |
| Хранилище | очередь Vercel, TTL 7 дней, без своей БД | memory / SQLite / Postgres, retention, дедупликация `(taskId, seq)` |
| Возможности | START/FOLLOW_UP/COMPACT/STOP, SYNC_STATE | то же + approvals, model/thinking, метрики, ограничение вывода инструментов, PWA с tool-карточками |
| Проверки | E2E-smoke не выполнялся (нужен Vercel Queues/OIDC) | 188 тестов, локальный E2E, аудит утечек, план деплоя |
| Зависимости | проприетарные Queues/OIDC | без обязательных; `pg` — опция |

Обе реализации несовместимы по: схеме `config.json` под ключом `cloud`, API
локальных модулей (`src/cloud/cloud-client.mjs`, `cloud-transport.mjs`),
`cloud/lib/*` и структуре каталогов.

## 2. Решение

**Основной вариант — облако ветки `feature/cloud-transport`.**
Cloud MVP из `master` удалён из этой ветки.

Причины:

1. Он покрывает функциональность MVP `master` плюс approvals, model/thinking,
   метрики и ограничение вывода инструментов — те вещи, которые ТЗ (§4) прямо
   просит переиспользовать («нормализатор событий, approvals и метрики облачной
   ветки»).
2. Он проверен локально (E2E: задача из облака исполняется через Pi RPC,
   события возвращаются, STOP работает), у MVP `master` E2E-smoke не выполнялся.
3. Он не завязан на конкретный инфраструктурный сервис: `npm run cloud` даёт
   рабочее облако на SQLite, Vercel/Postgres — опции. У MVP `master` нет
   локального режима без Vercel Queues/OIDC.
4. Размер реализации критерием не был; решали проверяемость, требования
   пользователя и стоимость переноса (ТЗ §4).

Что удалено (реализация MVP `master`):

- `cloud/api/bridge/*`, `cloud/api/{login,tasks,task-events,events-ack}.mjs`
- `cloud/lib/{http,protocol,queue}.mjs`, `cloud/package{,-lock}.json`, `cloud/vercel.json`
- `cloud/public/*`, `cloud/scripts/copy-vendor.mjs`, `cloud/.env.example`, `cloud/.gitignore`
- `src/cloud/{cloud-commands,cloud-event-state,cloud-outbox,cloud-sanitize}.mjs`
- `tests/cloud-queue.test.mjs`, `tests/cloud.test.mjs`, `docs/cloud-bridge.md`

Ядро `master` сохранено полностью и является авторитетным: сервер, TaskManager,
Pi RPC, worktree/apply, модели Pi, локальный router llama.cpp, MCP, UI 0.7.0.
Конфликтующие места разрешены в пользу `master`, облако ветки адаптировано под
его API.

## 3. Адаптация ветки облака под API `master` (ТЗ §2.2.12)

| Было в облачной ветке | Стало (API `master`) |
|---|---|
| `createTask({ id: cloudId, … })` | `createTask({ … }, { requestedId: cloudId })` (`src/cloud/command-dispatcher.mjs`) |
| `setModel(id, { provider, modelId })` | `setModel(id, provider, modelId)` |
| `setThinking(id, level)` | `setThinkingLevel(id, level)` |
| `Manager.setThinking` как признак поддержки | `setThinkingLevel` (`src/cloud/cloud-worker.mjs`, capabilities) |

Дублирующиеся маршруты `POST /api/tasks/:id/model` и `.../thinking` из облачной
ветки (они звали удалённые методы) убраны: остались маршруты `master`.

## 3.1. Хранилище облака: Redis, без базы данных

ТЗ v3 (разделы «Значит ли это, что TaskBridge нужна база данных?» и «Что
хранится в Redis») закрывает вопрос явно: **никакой application database**
(PostgreSQL / MySQL / Supabase DB / MongoDB) не нужно. Облако не хранит ни
сессии, ни задачи, ни историю, ни код, ни файлы — источник правды только ПК.

Нужен лишь минимальный shared-слой для маршрутизации между устройствами:
**Upstash Redis** (Vercel Marketplace) — канал по `machineId`, presence с TTL
~30 секунд, rate-limit. «Удалили Redis — не потеряли ни одной сессии».

Следствие для текущего кода: собственный store облака (memory / sqlite /
postgres в `cloud/lib/store.mjs`) — наследие прежней схемы, где облако было
хранилищем. Это то, что переделывается в облачном этапе; Postgres-адаптер при
новой схеме не требуется. Локальная сторона при этом сохраняется целиком:
очередь (outbox), `seq`, replay, идемпотентность `commandId`, approvals,
метрики — но живёт она на ПК.

Durable cloud inbox («поставить задачу при выключенном ПК») в ТЗ отнесён к
после-MVP и не требует полноценной БД.

## 4. Миграция локальной конфигурации

Блок `cloud` в `config.json` берётся из облачной ветки:

```jsonc
"cloud": {
  "enabled": false,
  "url": "",
  "machineId": "",
  "machineSecret": "",
  "machineDisplayName": "",
  "authMode": "bearer",
  "realtime": false,
  "eventFlushMs": 75,
  "eventBatchMax": 100,
  "eventBatchMaxKb": 256,
  "heartbeatSeconds": 20,
  "idlePollSeconds": 5,
  "activePollSeconds": 1,
  "maxOutboxMb": 100,
  "redactPaths": true,
  "coalesceDeltas": true,
  "toolOutput": { "rollingKb": 64, "tailKb": 64, "snapshotMs": 500, "maxFullMb": 4 }
}
```

Ключи MVP `master` (`machineSecretEnv`, `pollIntervalMs`, `maxBatchEvents`,
`maxPayloadKb`, `processedCommandLimit`) не поддерживаются: секрет задаётся
переменной `TASKBRIDGE_MACHINE_SECRET` или полем `machineSecret`, а окно
батча — `eventFlushMs` / `eventBatchMax` / `eventBatchMaxKb`.
`approvals` — новый блок (Этап A облачной ветки), по умолчанию выключен.

Важно для аварийной миграции: пока у машины в `config.json` остаётся только
старый блок `cloud` с ключами MVP, транспорт не включится — `enabled` читается
из облачной схемы, и запускать два исполнителя одной очереди нельзя
(ТЗ §4: «Не включать два исполнителя одной команды»). Переход — один раз,
вручную, с остановленным старым деплоем.

## 5. Что осталось непроверенным

Перенесено из [`cloud-transport-status.md`](cloud-transport-status.md) без
изменений: живой деплой на Vercel, Postgres-адаптер на живом сервере,
Git-автодеплой, approvals с реальной моделью, PWA на телефоне, длительный soak.
Локально: `npm run check`, `npm test` (215 pass, 1 skip), `npm run test:cloud`.
