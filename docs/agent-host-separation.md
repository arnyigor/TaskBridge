# AgentHost separation — дизайн (TZ v3, этап 9 / «шаг 5c»)

Цель шага 5: **перезапуск UI/gateway-процесса не должен убивать агента (Pi)
и не должен помечать активные задачи `FAILED_RECOVERY`.**

Это документ-проект: согласуем процессную модель и IPC-контракт, затем
внедряем отдельными проверяемыми этапами. Не слепой рефакторинг монолита.

## 1. Текущая модель (баг, который лечим)

Один OS-процесс `node src/server.mjs` владеет всем (`src/server.mjs`):

```
process server.mjs
 ├── TaskManager ── spawn ──▶ Pi (per task, pi-rpc, stdio pipes)
 │     └── runtimes Map, очередь, задачи, verification
 ├── RuntimeManager / local-models ──▶ llama.cpp (subprocess)
 ├── CloudWorker ── dispatcher.handle() ──▶ manager.* (in-process)
 ├── relayConnector (WS до relay, в том же процессе)
 ├── PushCenter + TrustedDevices + AccessControl
 └── HTTP/SSE  (клиентские маршруты, /api/tasks/*)
```

При `SIGTERM`/убийстве процесса (см. `scripts/restart-and-verify.mjs`):
- активные задачи на старте `init()` помечаются `FAILED_RECOVERY`
  (task-manager.mjs L~150: «its Pi process is gone»);
- Pi — прямые дети серверного процесса → осиротевают / stdin захлопывается;
- cloud worker/relay переподнимаются, но live-сессия агента теряется.

Вывод: **Pi не может пережить смерть родителя**. Реальная устойчивость
требует переноса владения Pi в отдельный процесс. Shortcut нет.

## 2. Целевая модель

```
                      ┌────────────────────────────┐
 host (node src/host.mjs)                          │  отдельный фоновый процесс
 │                                                   │  = владелец агента
 │  AgentHost = TaskManager + runtimes(Pi)           │
 │  + RuntimeManager/llama.cpp                       │
 │  + CloudWorker + relayConnector                   │  ← lock dataRoot здесь
 │  + PushCenter, TrustedDevices                      │
 │                                                    │
 └───────────┬────────────────────────────────────────┘
             │ IPC: 127.0.0.1:<hostPort> (token-auth, JSON)
             │   request/response (команды) + push (task-event) + readiness
             ▼
 ┌────────────────────────────┐
 │ gateway (node src/gateway.mjs)                    │
 │  HTTP/SSE + статика (web/)                        │
 │  client auth (cookie/pairing)                     │
 │  все /api/tasks/* и команды → IPC ─▶ host          │
 │  SSE: replay из host-истории, live из task-event   │
 └────────────────────────────┘
```

Принципы (по этапу 9 ТЗ):
- **host — единственный исполнитель команд и единственный писатель состояния
  задач.** gateway не меняет задачи напрямую и не конкурирует за server-lock.
- **instance-lock (dataRoot) держит host.** gateway стартует только поверх живого
  host (или поднимает его, как CLI в 5a).
- gateway не трогает задачи в обход: он IPC-клиент `AgentHost`.

## 3. Что именно переносится в host

Только то, что делает процесс «агентом» и что должно пережить рестарт UI:

| Компонент | Где сейчас | В целевом |
| --- | --- | --- |
| `TaskManager` (runtimes, spawn Pi, очередь, verification) | server.mjs | host |
| `RuntimeManager` / llama.cpp router (`local-models`) | server.mjs | host |
| `CloudWorker.dispatcher → manager.*` | server.mjs | host |
| `relayConnector` (WS до relay) | server.mjs | host |
| `PushCenter`, `TrustedDevices`, `AccessControl`* | server.mjs | host (владение событиями/доступом) |
| SQLite store (писатель событий) | server.mjs | host |
| HTTP/HTTPs + SSE-фан-аут + статика | server.mjs | gateway |
| чтение истории для replay | server.mjs | gateway → host (IPC) ***или*** диск, см. §4 |

\* AccessControl/пары можно оставить в gateway; решено при детализации. События
Push рождаются от `task-event`, который порождает host → PushCenter логичнее в
host (или получает события по IPC в gateway). Финально: **push.notify остаётся в
gateway**, а host передаёт `task-event` по IPC — тогда у пары «host+gateway» один
источник событий для SSE и Push.

## 3.1. Шаг остаётся клиентом host

Изначально клиенты ходят в gateway по HTTP/SSE (как сейчас, адрес не меняется).
`web/transport.mjs` (local/cloud) и весь web/app.js **не меняются** — это
проверяемое свойство рефакторинга: публичный API сохраняется.

## 4. IPC-контракт (host ⇄ gateway)

Канал: loopback TCP на `127.0.0.1:<hostPort>` (выбранному gateway), токен в
заголовке (генерируется host при старте, пишется в `data/host-ipc.json`
c `0660`; gateway читает и шлёт). Альтернатива — Unix-socket; на Windows
TCP-loopback проще и кросс-платформенно.

Токен НЕ равен machine-secret облака; это внутренняя пара host⇄gateway.

### 4.1. Readiness / обнаружение
- host отвечает на `HELLO {token}` → `{ok, build, hostPid, dataRoot}`.
  gateway при старте ждёт host, как CLI 5a ждёт порт.

### 4.2. Команды (request/response, JSON, id-корреляция)
Обёртки над существующими `manager.*` методами — **семантика не меняется**:
```
COMMAND {id, name, args}
```
например `name: "message"`, `"cancel"`, `"compact"`, `"model"`, `"thinking"`,
`"apply"`, `"worktree:delete"`, `"auto-compaction"`, `"from-session"`, `"new"`,
`"listProjects"`, `"listTasks"`, `"getTask"`, `"state"`, `"artifacts"`,
`"approvals"`, `"approval:resolve"`, `"pending:send"`, `"pending:delete"`,
`"files"`, `"uploads"`, `"events"`, `"model-catalog"`, `"model-info"`.

Ответ `RESULT {id, ok, data | error{code,message}}`. Коды ошибок → те же
`NOT_FOUND`/`BUSY`/`INPUT_INVALID` и т.д., чтобы gateway возвращал клиентам
прежние statusCode/body.

### 4.3. События (host → gateway, push)
- host шлёт `EVENT {taskId, event}` (это и есть текущий `task-event`) и
  `MODEL_STATUS`/`MODEL_PROGRESS` (`localModels.on(...)`).
- gateway держит `sseClients` и `push`, как сейчас, но источник — IPC-приём,
  а не in-process emitter.
- При (пере)подключении gateway шлёт `SUBSCRIBE {after}` и host доигрывает replay
  (или gateway читает replay из store; решает §5).

### 4.4. Потоки
- Одно TCP-соединение gateway⇄host, мультиплексом (id) или два: команды + events.
  Начать проще с **двух соединений**: `commands` и `events` (events — однонаправленный
  поток, как SSE). heartbeat по обоим.

## 5. Где читается история (важно для SSE-реплея)

Сейчас replay = `store.readEvents(...)` из SQLite на диске, live = emitter.
После разделения два варианта:
- **A. Gateway читает store.read() напрямую (тот же файл SQLite)**, host — единственный
  писатель. Требует WAL + read-only подключение gateway. Риск: два процесса к SQLite,
  но чтение при WAL безопасно. Плюс: replay не гоняется по IPC, SSE почти без изменений.
- **B. Всё чтение через IPC** (`COMMAND name:"events"`), gateway без доступа к SQLite.
  Чище по владению, но каждый SSE-реплей и список задач — IPC-запрос.

**Начать с A**, т.к. оно локализует изменения (gateway продолжает читать store;
переносим только запись и команды). Позже при желании B — отдельным шагом.
→ `store.mjs` переключается на WAL (`PRAGMA journal_mode=WAL`), чтобы concurrent
reader в gateway и writer в host не блокировали друг друга.

## 6. instance-lock и два процесса

- `acquireInstanceLock(dataRoot)` держит **host** (он пишет состояние задач).
- gateway НЕ берёт lock (не пишет состояние задач). Но gateway загружает/стримит
  uploads и static — это не задача-исполнение; отдельные файлы, не под lock.
- Барьер: при старте gateway проверяет host через `HELLO`; если host нет —
  поднимает (см. CLI 5a) или сообщает `not running`.
- CLI `taskbridge status/stop` читают lock — остаётся корректным (host - владелец).
  `taskbridge start` поднимает **host, затем gateway**.

## 7. Завершение (shutdown), которое сейчас отсутствует

У `TaskManager` нет `close()`, и `SIGTERM` сервера не гасит рантаймы. Добавить
в host:
- `AgentHost.close()`: пройти по `runtimes`, `pi.closeStdin()`→таймаут→`killTree()`,
  остановить llama.cpp-роутер (`local-models.stop()`), погасить relay/cloud,
  `store.close()`, `lock.release()`.
- `SIGTERM/SIGINT` host = graceful: сначала закрыть канал gateway (gateway
  перейдёт к переподключению к новому host), затем close агента. Это отдельный
  сценерно от «gateway перезапускается без остановки host».

## 8. Фазы внедрения (каждая — зелёный прогон + проверяемый сценарий)

> Статус фазы: реализованы P-1…P-3 начало (IPC-транспорт, AgentHost, gateway+
> acceptance), фазы ниже помечены. Split — опт-ин (`npm run start:split`),
> дефолт остаётся монолитом.

**P-1. Жизненный цикл + костяк двух процессов (без изменения поведения).**
- `src/host.mjs`: поднимает lock, store, TaskManager, RuntimeManager, CloudWorker,
  relayConnector, PushCenter — ровно то, что сейчас собирает server.mjs L~29–175.
- `src/gateway.mjs`: HTTP/SSE/статика; пока **сам создаёт тот же локальный
  TaskManager in-process** (режим legacy/монолит) — поведение не меняется.
- `server.mjs` становится тонким лаунчером: `host || (monolith)`. Публичный
  API и тесты зелёные без изменений.
  → **Проверка:** всё как сейчас, ноль регрессий. Коммит без расхождения.

**P-2. IPC-канал + переключение gateway на host.**
- TCP loopback + токен + `HELLO/COMMAND/RESULT/EVENT`.
- gateway: все вызовы `manager.*` за ширмой `agent` (in-process = тот же объект,
  пока host не запущен). Затем gateway реально гоняет команды и события через
  IPC к host.
- store: WAL.
- Моргает `task-event`-путь: host `EVENT` → gateway → SSE + push.
  → **Проверка:** команды и live-стрим работают через IPC; SSE-реплей не дублирует.

**P-3. Устойчивость к рестарту gateway (цель шага 5).**
- Убить/перезапустить только gateway во время генерации: Pi-процесс жив (host),
  задача НЕ `FAILED_RECOVERY`; после поднятия нового gateway сессия продолжается,
  история на месте, live-события возобновляются.
  → **Проверка:** acceptance §10.

**P-4. Остальное.**
- `taskbridge open/status/start/stop` переключить на host+gateway (CLI 5a не меняется
  API). `restart-and-verify` → restart gateway (host остаётся). Graceful shutdown host
  (раздел 7).

## 9. Откат

Каждая фаза отдельным коммитом; P-1 — чисто аддитивный лаунчер (host можно не
использовать, остаётся монолит). Если P-2/P-3 ломает что-то на живом сервере —
переключить обратно на `server.mjs` (legacy in-process), потому что legacy-путь
не удаляется до полной замены. Это требование: **monolith keep** до зелёного P-4.

## 10. Acceptance (шаг 5)

1. Запущен host+gateway. Послана задача, Pi стримит.
2. Убит только gateway (`node src/gateway.mjs` → SIGTERM). Pi продолжает, задача
   остаётся RUNNING (не FAILED_RECOVERY).
3. Gateway переподнят (CLI или вручную). Клиент видит ту же сессию, историю и
   возобновлённый live-поток; можно follow-up.
4. `taskbridge status` показывает host (и gateway); `stop` корректно гасит оба;
   повторный `start` поднимает host затем gateway.
5. Обычный рестарт **host** тоже безопасен (graceful §7): принятая очередь/outbox
   переживают; неоднозначный Run показывается явно (этап 9 ТЗ: «история
   восстановлена» ≠ «выполнение возобновлено»). Авто-resume — только для
   доказуемо безопасных случаев.

## 11. Вне зоны (для 5c)

- SessionManager/Run/PiRunner (ТЗ этап 2) — отдельный контур: 5c реорганизует
  процесс, но не вводит новую модель данных сессий.
- E2EE, несколько клиентов с sequencer, Android/KMP — позже.
- `taskbridge pi` как терминальный клиент — не делаем (по решению «бразуер-first»).

## 12. P-4: инвентаризация остатка (замер перед продолжением)

Статус на 2026-09-14: P-1…P-3 сделаны (IPC-транспорт, `AgentHost`, gateway,
acceptance) — `npm run split:acceptance` зелёный. Дефолт по-прежнему монолит,
потому что gateway отдаёт **6 групп маршрутов из ~40**. Замер:

| Область | Монолит `server.mjs` | Gateway |
|---|---|---|
| health / info | ✅ полный payload | ⚠️ заглушка `{ build: { version: 'gateway' } }` — в split-UI видна «версия gateway», нет `engine`/`system` |
| projects / tasks / uploads / commands | ✅ | ✅ (подмножество) |
| `tasks/:id` — events, stream, state, message, cancel, compact, model, thinking, auto-compaction, apply, worktree, approvals | ✅ | ✅ |
| `tasks/:id` — turns/edit, turns/delete, regenerate, fork, undo-last-turn, artifacts(+`:name`), files/:id, workspace-file, runs | ✅ | ❌ |
| models | ✅ | ❌ |
| native-sessions(+preview), `projects/:id/pi-sessions` | ✅ | ❌ |
| project-browser(+register), `DELETE projects/:id` | ✅ | ❌ |
| mcp (status / mode / import / servers / tools) | ✅ | ❌ (в IPC есть только `mcpStatus`) |
| local (router: status / load / unload / stop / start / events) | ✅ | ❌ |
| runtime (status / start / restart) | ✅ | ❌ |
| metrics (JSON + Prometheus) | ✅ | ❌ |
| push (key / subscribe / unsubscribe / test) | ✅ | ❌ |
| auth (status / pair / pairing) | ✅ | ❌ |
| cloud (`/api/cloud/*`), `/debug/cloud` | ✅ | ❌ |

Вывод: «сделать split дефолтом» нельзя без переноса ~30 групп маршрутов и
расширения IPC-контракта. Отсюда развилка (обе дают цель шага 5 — рестарт
gateway не убивает агента):

**Вариант A — текущий курс дизайна.** Явные команды IPC на каждый маршрут.
Плюс: типизированный контракт, нет второго HTTP-прыжка.
Минус: ~30 маршрутов дублируются в двух таблицах (монолит и gateway) → дрейф,
а именно он и ломает «стабильное ядро».

**Вариант B — host поднимает полный HTTP-апп на loopback, gateway становится
тонким прокси** (TLS и авторизация — на стороне gateway, лицевой части LAN).
Плюс: 100 % паритета по построению, одна таблица маршрутов, gateway перестаёт быть
второй реализацией API (перестаёт «врать», как сейчас с `version: 'gateway'`).
Минус: host перестаёт быть «headless» (§3 этого не предполагал); лишний локальный
HTTP-прыжок; часть работы P-2 (таблица маршрутов gateway) становится ненужной.

Решение по A/B принимает владелец проекта: оно определяет весь остаток P-4.

### 12.1. Решение: вариант B, и что уже сделано

Владелец проекта выбрал **B** (паритет по построению, одна реализация API).
Откат — всегда `node src/server.mjs`, поведение по умолчанию не менялось.

| Шаг | Что | Статус |
|---|---|---|
| 1 | `src/proxy.mjs` — турникет: `Host` не подменяется, тела не буферизуются (upload/SSE насквозь), 502 при мёртвом апстриме | ✅ `19805ad` |
| 2 | лаунчер `npm run lan:start` (app на loopback + прокси на LAN), TLS на прокси, `TASKBRIDGE_BIND_HOST` / `TASKBRIDGE_PUBLIC_PORT` / `TASKBRIDGE_DISABLE_TLS` | ✅ |
| 3 | паритет как свойство: `tests/lan-mode.test.mjs` прогоняет **весь опубликованный контракт** через прокси (не «шесть портированных маршрутов») | ✅ |
| 4 | старые IPC-маршруты gateway (`src/gateway.mjs`, `src/agent-host.mjs`) — удалить или оставить вторым режимом | ⏳ решение |
| 5 | дефолт (`npm start`, `start.cmd`, `taskbridge start`) перевести на лаунчер; `restart-and-verify` — только прокси | ⏳ |
| 6 | `bin/taskbridge.mjs` (`status`/`stop`/`doctor`) знать про два процесса | ⏳ |

Риски, которые B обязан закрыть, и где они закрыты:

- **внутренний сервер не должен быть виден в сети** → лаунчер запускает app с
  `TASKBRIDGE_BIND_HOST=127.0.0.1`; прокси — единственная дверь;
- **код парринга** → прокси не подменяет `Host` (тест в `tests/proxy.test.mjs`), а
  `/api/auth/pairing` требует и loopback-адрес, и loopback-Host;
- **потоки и большие файлы** → тела пайпятся, SSE флашится с первым байтом;
- **URL approvals для Pi-расширения** → app остаётся владельцем `approvalBaseUrl`
  (внутренний порт ему известен), прокси в это не вмешивается;
- **HTTPS и адрес в шапке** → TLS на прокси; app печатает и отдаёт в `/api/info`
  публичный порт (`TASKBRIDGE_PUBLIC_PORT`), а не свой внутренний.
