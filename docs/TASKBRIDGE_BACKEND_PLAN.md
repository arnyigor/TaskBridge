# TaskBridge Backend — план доработок (agentd)

Цель: превратить TaskBridge в центральный supervisor агентных сессий, к которому одновременно подключаются браузер, CLI (`taskbridge pi`) и KMP-клиенты (Desktop/Android). Все клиенты работают с **одним и тем же** живым runtime Pi, без повторного запуска и без потери контекста.

Документ по клиентам: [`TASKBRIDGE_KMP_PLAN.md`](TASKBRIDGE_KMP_PLAN.md). Он зависит от этапов B3–B4 этого плана: контракт должен быть заморожен до начала активной разработки KMP.

> **Главное изменение этой редакции.** Первая версия плана писалась как с нуля. Но в коде уже есть
> большая часть фундамента: опубликованный контракт `apiVersion = 1`, SSE с `seq` и реплеем без дыр,
> идемпотентность через `commandId` с журналом в SQLite, `fake-pi`, импорт внешних Pi-сессий,
> подтверждения инструментов, graceful shutdown и LAN-турникет. Поэтому план переписан как
> **дельта к текущему коду**: что уже есть, что доделать, что меняем осознанно. Параллельный
> API `/v1` рядом с `/api` не строим: две таблицы маршрутов уже один раз отвергнуты
> ([agent-host-separation.md §12](agent-host-separation.md)) по той же причине.

---

## 0. Исходное состояние (сверено с кодом)

| Пункт плана | Состояние | Где в коде | Что осталось |
|---|---|---|---|
| Один процесс Pi на сессию | ✅ есть | `TaskManager.runtimes` (`Map taskId → {pi}`), `src/pi-rpc.mjs` | — |
| Очередь команд на сессию | 🟡 частично | `#admit` (глобальный мьютекс), `pendingPrompts`, `eventChain` | единый актор на сессию вместо глобального мьютекса (B1) |
| Буферизация stdout, UTF-8 на границе чанков | ✅ есть | `pi-rpc.mjs` (`StringDecoder`, строгий LF-JSONL) | — (тест: `tests/pi-rpc-faults.test.mjs`) |
| Таймауты RPC-запросов | ✅ есть | `pi-rpc.mjs` (idle-таймер, `tests/rpc-timeout.test.mjs`) | — |
| Убийство дерева процессов | 🟡 частично | `killTree()`: Windows `taskkill /T /F`; POSIX — группа процессов (Pi запускается `detached`, исправлено в B0) | Job Object, сироты по PID+времени старта (B1) |
| SQLite, WAL, миграции | ✅ есть | `task-store.mjs`: `tasks`, `events`, `meta`, `PRAGMA user_version` | таблицы `runtimes`, `ui_requests` (B2) |
| `seq` монотонный, атомарный | ✅ есть | `task-store.mjs`, `events/event-sequence.mjs` | — |
| Реплей без дыр при подписке | ✅ есть | `server.mjs`, `/api/tasks/:id/stream`: подписка → чтение БД → буфер → live | тот же алгоритм для списка сессий (B3) |
| Идемпотентность промптов | ✅ есть | `#withCommand`, `commandId`+`clientId`, журнал в SQLite, `UNKNOWN_AFTER_CRASH` → `409`; `USER_MESSAGE`/`PROMPT_QUEUED` несут `commandId`/`pendingId` | — (переименовывать в `idempotencyKey` не нужно) |
| Стриминговые дельты не копятся | 🟡 иначе | `event-trim.mjs`: `message_update` пишутся и вычищаются после `message_end` | решить, переходить ли на live-кадры без `seq` (см. B2) |
| Усечённый вывод инструментов + полный по запросу | ✅ есть | `tool-output.mjs`, `GET /api/tasks/:id/tools/:toolCallId/output` | — |
| Контракт API + проверка | ✅ есть | `src/api-contract.mjs`, `docs/api-contract.md`, `tests/api-contract.test.mjs` | Bearer-токен, нормализованные события, состояния runtime (B3) |
| Подтверждения инструментов | ✅ есть | `pi-extension/taskbridge-approval.js`, `APPROVAL_REQUIRED/RESOLVED`, `/approvals` | обобщить до любых UI-запросов расширений (B4) |
| Общие UI-запросы расширений Pi | ❌ нет | в RPC-клиенте не обрабатываются | B0 (разведка) + B4 |
| fake-pi | ✅ есть | `tests/fake-pi.mjs`: turn, модели, approvals, сессии, `--version`, режимы `fault-crash/garbage/utf8/hang/deaf/child` | воспроизведение записанных транскриптов (B0) |
| Проверка версии Pi | ✅ есть | `src/pi-version.mjs`, `/api/info` → `pi`, предупреждение `PI_VERSION_UNSUPPORTED` | — |
| Параллельные сессии | ❌ сознательно нет | `activeTaskId`, capacity=1, [multi-session-queues.md](multi-session-queues.md) | B5 — отдельное решение, см. там |
| Hibernate по простою | ❌ нет | — | B6 |
| Восстановление после падения daemon'а | 🟡 частично | `init()`: активные → `FAILED`/`FAILED_RECOVERY`, следующее сообщение поднимает Pi с тем же `--session` | переименовать в честное состояние `RESTORABLE` (B6) |
| Graceful shutdown | ✅ есть | `TaskManager.close()` | — |
| Устойчивость к рестарту UI-слоя | ✅ есть | LAN-турникет `src/proxy.mjs` (вариант B) | — |
| Внешние сессии: view/clone/take-over | ✅ почти всё | `native-sessions.mjs`, `pi-session-index.mjs`, `POST /api/tasks/from-session` (`clone` / `take-over` + `confirmedClosed`) | автоматическая проверка «внешний Pi мёртв и JSONL не меняется» (B9) |
| CLI | 🟡 частично | `bin/taskbridge.mjs`: `open/status/doctor/start/stop` | подкоманды `pi …` как клиент API (B8) |
| Уведомления | 🟡 только браузер | `push/` (web-push, VAPID) | для Android без FCM — через клиентский foreground service (см. KMP K7) |
| Удалённый доступ | 🟡 выключен | `src/cloud/*`, `cloud/*` (`cloud.enabled: false`) | вне этого плана |

Легенда: ✅ есть · 🟡 частично / иначе · ❌ нет.

---

## 1. Целевая архитектура

```
                    ┌──────────────────────── TaskBridge (loopback) ──────────────────────┐
                    │                                                                      │
  Browser ──┐       │  HTTP API (/api/*, apiVersion N) + SSE                               │
  CLI ──────┼─proxy─►│    │                                                                 │
  KMP ──────┘ (LAN) │    ▼                                                                 │
                    │  TaskManager ──(выносим)──► SessionRegistry · RuntimeSupervisor      │
                    │    │                         ModelScheduler (capacity N, по умолч. 1) │
                    │  PiRpcSession (per conversation) ── актор команд ── state machine    │
                    │    │                     │                                           │
                    │  TaskStore (SQLite) ◄────┘  EventBus ──► SSE-клиенты / push          │
                    └────┼─────────────────────────────────────────────────────────────────┘
                         ▼
                  pi --mode rpc --session <file>.jsonl   (1 процесс на 1 conversation)
```

Процессная модель остаётся текущей (вариант B): приложение на loopback владеет Pi, в LAN смотрит турникет `proxy.mjs`. Смерть приложения = смерть его Pi; мы **не** пытаемся переподключаться к осиротевшему Pi — такая сессия становится `RESTORABLE` и поднимается заново с тем же `--session`.

### Сущности и словарь

В коде сущности называются иначе, чем в первой редакции плана. Код не переименовываем, план использует такое соответствие:

| Термин плана | Что в коде | Хранится |
|---|---|---|
| Workspace | Project (`/api/projects`) или Scratch | `config.json` / SQLite |
| Conversation (Session) | Task (`/api/tasks/:id`), `sessionId === taskId` (`session-manager.mjs`) | SQLite `tasks` + Pi JSONL |
| Runtime | `runtimes.get(taskId).pi` — живой `pi --mode rpc` | память + PID в SQLite (новое, B1) |
| Client | подключение SSE / устройство с `clientId` | память |
| Команда | `commandId` в журнале команд | SQLite |

Pi JSONL — истина для модели. SQLite — истина для менеджера. JSONL не используется как база данных менеджера.

---

## 2. Инварианты (проверяются тестами)

| # | Инвариант | Сейчас | Тест |
|---|---|---|---|
| I1 | У одной Conversation не больше одного живого Runtime | держится на коде `runtimes` | добавить явный тест гонки «два resume одновременно» |
| I2 | Запись в stdin Pi идёт только через очередь команд сессии | частично (`#admit`) | B1 |
| I3 | Событие сначала пишется в SQLite, потом рассылается | ✅ | есть |
| I4 | `seq` в сессии строго монотонный и без пропусков | ✅ | есть |
| I5 | Нет живого процесса без записи и записи `LIVE` без процесса | ❌ (PID не хранится) | B1/B6 |
| I6 | `stop`/`hibernate` завершают всё дерево процессов | ✅ при живом daemon'е (Windows `taskkill /T`, POSIX — группа процессов); ❌ при аварийном kill daemon'а | `tests/runtime-faults.test.mjs`; Job Object — B1 |
| I7 | Каждый UI-запрос разрешается ровно один раз | ✅ для approvals | распространить на все UI-запросы (B4) |
| I8 | Команда с одним `commandId` выполняется не более одного раза, **в том числе после рестарта** | ✅ (`UNKNOWN_AFTER_CRASH`) | есть |
| I9 | JSONL одной Conversation пишет не больше одного Pi | 🟡 `take-over` требует ручного `confirmedClosed` | B9 |
| I10 | Клиент может отличить «та же база» от «база пересоздана/восстановлена из бэкапа» | ✅ `storeId` в `/api/info`, у бэкапа свой | `tests/store-identity.test.mjs` |

I10 новый: после восстановления из `npm run backup` или удаления `data/` `seq` начинается заново, и кэш клиента с `lastSeq = 1284` молча перестанет получать события. Решение — случайный `storeId`, создаваемый вместе с БД и отдаваемый в `/api/info` и в snapshot; клиент при несовпадении сбрасывает кэш.

---

## 3. Состояния

### 3.1 Две оси вместо одной

Первая редакция смешивала в одном списке состояние хода (`WORKING`), состояние процесса (`HIBERNATED`) и происхождение сессии (`EXTERNAL`). Это разные оси, и клиенты должны получать их раздельно:

| Поле | Значения | Смысл |
|---|---|---|
| `status` (есть) | `QUEUED · PREPARING · PREFLIGHT · RUNNING · WAITING_USER · VERIFYING · CANCELLING · SUCCEEDED · FAILED · CANCELLED` | состояние работы/хода. **Не меняем** — на нём стоит веб-клиент и контракт v1 |
| `runtime.state` (новое) | `NONE · STARTING · LIVE · STOPPING · HIBERNATED · RESTORABLE` | есть ли живой Pi и можно ли его поднять |
| `runtime.activity` (новое) | `null · waiting_model {position} · tool {name, summary} · streaming · compacting` | что происходит прямо сейчас |
| `ownership` (новое) | `OWNED · EXTERNAL_VIEW · CLONED` | чья это сессия |

Производное «для UI» (`WORKING / WAITING_USER / IDLE / …`) — функция от этих полей, вычисляется **на сервере** и отдаётся полем `displayState`, чтобы веб, CLI и KMP показывали одно и то же:

| `displayState` | Условие |
|---|---|
| `WAITING_USER` | `status = WAITING_USER` или есть неразрешённый UI-запрос |
| `WORKING` | `status ∈ {PREPARING, PREFLIGHT, RUNNING, VERIFYING, CANCELLING}` |
| `QUEUED` | `status = QUEUED` (ждёт модель или первый запуск) |
| `STARTING` | `runtime.state = STARTING` |
| `IDLE` | `runtime.state = LIVE`, хода нет |
| `HIBERNATED` | `runtime.state = HIBERNATED` |
| `RESTORABLE` | `runtime.state = RESTORABLE` (упал Pi или daemon; бывший `FAILED_RECOVERY`) |
| `CLOSED` | `runtime.state = NONE`, хода нет |
| `EXTERNAL` | `ownership = EXTERNAL_VIEW` |

### 3.2 State machine Runtime

| Из | Событие | В |
|---|---|---|
| `NONE` / `HIBERNATED` / `RESTORABLE` | start / resume / prompt | `STARTING` |
| `STARTING` | Pi ответил на `get_state` | `LIVE` |
| `STARTING` | ошибка запуска / таймаут | `RESTORABLE` (с причиной) |
| `LIVE` | idle-таймаут, не `pinned`, хода нет | `STOPPING` → `HIBERNATED` |
| `LIVE` | неожиданный выход процесса | `RESTORABLE` (код выхода, хвост stderr) |
| `LIVE` / `STARTING` | stop | `STOPPING` → `NONE` |
| любое живое | старт daemon'а после падения (reconciliation) | `RESTORABLE` |

Ход (`status`) и runtime связаны правилами: ход может идти только при `LIVE`; выход процесса во время хода завершает ход `FAILED` с `errorCode = RUNTIME_EXITED` и переводит runtime в `RESTORABLE`.

Правила:
- переход не из таблицы — ошибка в лог с `sessionId`, состояние не меняется, тест на каждый запрещённый переход;
- каждое изменение `runtime.state` / `activity` — событие `RUNTIME_STATE` (новый тип, в дополнение к существующим `RUNTIME_*`);
- ожидание слота модели — не состояние, а `activity: waiting_model` (сейчас это `QUEUED` + `queueReason`).

---

## 4. Этапы

### B0. Подготовка и страховка

Цель: зафиксировать реальное поведение Pi до рефакторинга.

- [x] Зафиксировать поддерживаемый диапазон версий Pi (сейчас `>=0.85.0 <0.88.0`; 0.87.1 проверен на рабочей машине). `pi --version` при старте; при несовпадении — `piVersion` + `piVersionSupported: false` в `/api/info` и баннер в UI. Не блокировать работу.
- [ ] Записать реальные RPC-транскрипты (stdin и stdout JSONL) как fixtures в `tests/fixtures/pi-rpc/`. Скрипт записи — поверх `scripts/pi-rpc-smoke.mjs`:
  - обычный turn с текстовым ответом;
  - turn с несколькими tool calls;
  - `abort` посреди tool call;
  - ошибка модели / недоступный провайдер;
  - **extension UI-запрос** (confirm/select/input) и ответ на него — главная цель разведки.
    Первая запись с реального Pi 0.87.1 (smoke через `scripts/pi-rpc-record.mjs`) показала: даже простой prompt даёт ~10 кадров `extension_ui_request` от установленных расширений (MCP, pi-limits-wait, plannotator) — методы `setStatus`, `notify`, `setWidget`; `statusText` содержит ANSI-коды. TaskBridge их сейчас никак не обрабатывает. Для уведомлений это безвредно, но **интерактивный запрос (confirm/select) почти наверняка подвесит ход** — нужна отдельная запись с расширением, которое действительно спрашивает;
  - `compact`, `set_model`, `set_thinking_level`;
  - `steer` и `follow_up` во время стриминга;
  - длинный вывод инструмента.
- [ ] Документ `docs/pi-rpc-protocol.md`: какие команды и события мы используем, по транскриптам. Сейчас используются `prompt`, `steer`, `follow_up`, `abort`, `clear_queue`, `compact`, `get_state`, `set_model`, `set_thinking_level`, `get_available_models`, `get_available_thinking_levels` — сверить, дописать то, что нашлось.
- [x] Режимы отказа в `tests/fake-pi.mjs` (ключевые слова `fault-*` в промпте) и тесты на них: `tests/pi-rpc-faults.test.mjs`, `tests/runtime-faults.test.mjs`. Найдено и исправлено: на POSIX `killTree` не убивал детей Pi (Pi не был лидером группы процессов).
- [ ] Воспроизведение записанного fixture-файла в `tests/fake-pi.mjs` + режимы отказа по переменной окружения — упасть на N-м кадре, зависнуть, ответить с задержкой, оборвать строку JSON, записать мусор в stdout, записать кириллицу, разрезанную посреди символа.
- [ ] Характеризационные тесты там, где их нет: браузер продолжает живую сессию после переподключения SSE; restore после рестарта; capacity=1.

**Готово, когда:** сценарий «prompt → tools → settled» проходит на fake-pi в CI за секунды; все fixtures проигрываются; формат UI-запросов расширений задокументирован.

---

### B1. Ядро runtime

Цель: вынести из `task-manager.mjs` (2600 строк) владение процессом Pi в `RuntimeSupervisor` + `PiRpcSession` с явной state machine. Делается **по шагам без изменения внешнего поведения** (strangler): после каждого шага зелёный `npm test` и `npm run lan:acceptance`.

- [ ] Шаг 1: `RuntimeSupervisor` владеет `runtimes` Map и state machine из 3.2; `TaskManager` вызывает его вместо прямой работы с `pi`. Каждое изменение — событие `RUNTIME_STATE`.
- [ ] Шаг 2: актор команд на сессию. Все операции (prompt, steer, abort, ui-response, compact, set_model, stop, hibernate) — сообщения в очередь сессии. Глобальный `#admit` остаётся только для admission в слот модели (B5).
- [ ] Шаг 3: stderr Pi → отдельный лог сессии (уже `pi.stderr.log`), последние N строк — в причину `RESTORABLE`.
- [ ] Шаг 4: PID и время старта процесса в SQLite (таблица `runtimes`). При старте daemon'а — найти и завершить сирот (сверка PID + время старта процесса, чтобы не убить чужой процесс с переиспользованным PID).
- [ ] Шаг 5, Windows: Job Object с kill-on-close, чтобы Pi и его дети (pytest, gradle) умирали вместе с daemon'ом даже при аварийном kill. Node этого не умеет из коробки: варианты — маленький нативный helper-exe или запуск Pi через обёртку. `taskkill /T /F` остаётся запасным путём. Решение — в B0 по результатам прототипа.

**Готово, когда:** на fake-pi проходят тесты: kill во время tool call, отсутствие ответа на команду, оборванная строка JSON, кириллица на границе чанка, stop с долгоживущим дочерним процессом (после stop процессов не остаётся), kill -9 daemon'а → при следующем старте сирот нет.

---

### B2. Модель данных

Существующая схема (`tasks` с JSON в `data`, `events` с JSON в `payload`, `meta`) остаётся. Добавляем только недостающее, миграцией через `PRAGMA user_version`:

- [ ] `runtimes(task_id PK, pid, process_started_at, state, activity_json, started_at, exit_code, exit_reason)`.
- [ ] `ui_requests(id PK, task_id, kind, payload_json, status, resolved_by_client_id, resolved_at, created_at)` — общая таблица для approvals и UI-запросов расширений (сейчас approvals живут отдельно).
- [x] `meta.store_id` — случайный id базы (I10); копия из `backup()` получает свой.
- [ ] В `tasks.data`: `pinned`, `ownership`, `lastActivityAt`.
- [ ] Стриминговые дельты. Сейчас `message_update` пишутся в БД и вычищаются после `message_end` (`event-trim.mjs`). Вариант первой редакции — дельты вообще не писать, отдавать live-кадрами без `seq`, а незавершённый текст держать в памяти и отдавать в snapshot. **Рекомендация: перейти на live-кадры**, потому что:
  - KMP-клиенту не нужно фильтровать мёртвые дельты из истории;
  - меньше записей в SQLite на каждый токен.
  Цена: переписать `event-trim.mjs` и потоковую часть `web/chat-state.mjs` (B7). Формат live-кадра — в B3.
- [ ] Политика хранения: выводы инструментов старше N дней сжимаются/удаляются, сообщения остаются. Настройка в `config.json`.

**Готово, когда:** после рестарта daemon'а список сессий, `runtime.state` (живые → `RESTORABLE`) и история событий совпадают с состоянием до рестарта.

---

### B3. Контракт API для всех клиентов

Не делаем параллельный `/v1`: развиваем `/api/*` по уже принятому правилу версий ([api-contract.md](api-contract.md)). Добавления — без поднятия версии; изменение формы существующего — `API_VERSION = 2`. Всё, что ниже, — добавления, кроме пунктов, помеченных **(v2)**.

#### 3.1 Авторизация (блокер для KMP)

- [ ] `Authorization: Bearer <token>` в дополнение к cookie. Токен — на устройство, с `clientId`, отзываемый. Хранится хэшем.
- [ ] Pairing для нативных клиентов: на ПК UI показывает QR с `{url, pairingCode, certFingerprint?}`; клиент меняет код на токен через `POST /api/auth/token`. `certFingerprint` — SHA-256 self-signed сертификата (`tls.mjs`), чтобы клиент мог закрепить его (TOFU) вместо отключения проверки TLS.
- [ ] `GET /api/auth/devices`, `DELETE /api/auth/devices/:id` — список и отзыв устройств (по аналогии с `/api/cloud/devices`).

#### 3.2 Представление сессии

- [ ] В `Task` добавить `runtime {state, activity, pid?, startedAt?}`, `displayState`, `ownership`, `pinned`, `lastActivityAt`, `presence[]`.
- [ ] `GET /api/tasks?projectId=&displayState=` — фильтры.
- [ ] `PATCH /api/tasks/:id` принимает `{title?, pinned?}` (сейчас только rename).
- [ ] `POST /api/tasks/:id/resume`, `POST /api/tasks/:id/stop` (stop = завершить runtime без удаления сессии; отличается от `cancel`, который прерывает ход).
- [ ] `GET /api/info` → `storeId`, `piVersion`, `piVersionSupported`, `capabilities[]` (например `live-frames`, `ui-requests`, `presence`), чтобы клиент мог включать функции по наличию, а не по номеру версии.

#### 3.3 События

Сейчас клиенту приходят `PI_EVENT` с сырым кадром Pi в `data.pi`. Для веба это терпимо, для KMP — нет: клиент на Kotlin будет повторять разбор протокола Pi, и любое изменение Pi ломает трёх клиентов вместо одного сервера. Нормализатор для облака уже есть (`src/events/event-normalizer.mjs`).

- [ ] Добавить в каждое событие поле `norm` — нормализованное представление (через существующий `event-normalizer`), не удаляя `data.pi`:
  ```json
  {
    "taskId": "c_7da2", "seq": 1284, "ts": "2026-09-24T21:14:03.120Z",
    "type": "PI_EVENT",
    "source": { "kind": "pi", "clientId": null },
    "norm": { "kind": "tool.started", "toolCallId": "t_91", "name": "bash", "summary": "pytest tests/world_model" },
    "data": { "pi": { "...": "сырой кадр, для отладки" } }
  }
  ```
  Нормализованные виды: `message.user`, `message.assistant`, `thinking`, `tool.started`, `tool.finished`, `ui.request`, `ui.resolved`, `prompt.queued`, `prompt.dispatched`, `prompt.dropped`, `runtime.state`, `turn.started`, `turn.finished`, `history.edited`, `history.truncated`, `model.changed`, `compaction`, `error`.
- [ ] `source.kind` для пользовательских событий: `web | cli | android | desktop | cloud` (из `clientKind` устройства).
- [x] `USER_MESSAGE` несёт `commandId`/`clientId` (и `pendingId` при доставке из очереди), каждое сообщение в очереди — событие `PROMPT_QUEUED {pendingId, commandId?, clientId?}`. По ним клиент после `UNKNOWN_AFTER_CRASH` проверяет, дошло ли сообщение до агента.
- [ ] События правки истории (`TURN_EDITED`, `TURN_TRUNCATED`, `TASK_FORKED`) явно описать в контракте как **переписывающие** состояние клиента: `TURN_EDITED` меняет событие с тем же `seq`, `TURN_TRUNCATED {fromSeq}` удаляет всё после `fromSeq`. Клиентский кэш обязан это поддерживать.
- [ ] JSON Schema для `Task`, `TaskEvent`, `norm.*`, кадров потока — в `docs/schema/`, из неё генерируются или против неё проверяются модели клиентов (KMP K1). Тест в `api-contract.test.mjs` проверяет, что реальные ответы проходят схему.

#### 3.4 Поток сессии

Транспорт — **SSE остаётся основным** (`/api/tasks/:id/stream`): реплей без дыр уже реализован, работает через турникет и из браузера, в Ktor есть SSE-клиент. WebSocket не добавляем, пока нет задачи, которую SSE + REST не решают (см. открытые вопросы).

- [ ] Параметры подключения: `?after=&clientId=&clientKind=` (для presence). `Last-Event-ID` продолжает работать.
- [ ] Первым кадром после подключения — `event: snapshot` с `{task, lastSeq, storeId, live: {messageId, text, thinking, offset} | null, presence}`.
- [ ] Live-кадры (если B2 перешёл на них) — `event: live`, **без `id:`**, чтобы не сдвигать `Last-Event-ID`:
  ```json
  { "messageId": "m_42", "turnId": "u_17", "channel": "text", "offset": 1820, "delta": "…" }
  ```
  `offset` — позиция дельты в тексте сообщения. Клиент применяет дельту, только если `offset` равен длине уже накопленного текста, иначе ждёт финального `message.assistant` или берёт текст из следующего snapshot. Без `messageId`/`offset` клиент не может ни понять, к какому сообщению относится дельта, ни обнаружить пропуск дельты после переподключения.
- [ ] `event: presence` при изменении списка подключённых.
- [ ] Heartbeat-комментарий `: ping` раз в 15–25 с, чтобы мобильные сети и прокси не рвали молчащее соединение.
- [ ] `GET /api/stream` — SSE списка сессий: изменения `Task` (`displayState`, `runtime`, `title`, `lastActivityAt`) всех сессий. Свой `seq` на уровне daemon'а в памяти + snapshot всего списка при подключении (история изменений списка не нужна).

#### 3.5 Ошибки

- [ ] Конверт остаётся `{error, code}`, добавляется необязательный `state` (текущий `displayState`) для `409`.
- [ ] Коды: `404 NOT_FOUND`, `409 INVALID_STATE` / `MODEL_BUSY` (есть), `423 EXTERNAL_SESSION`, `429 RUNTIME_LIMIT` (`429 RATE_LIMITED` уже занят лимитом авторизации — различаются по `code`), `409 UI_REQUEST_RESOLVED`. Список — в `api-contract.md`, коды — стабильные строки, клиент ветвится по `code`, а не по тексту.
- [x] **Баг, чинить сразу, не дожидаясь B3:** `CONFLICT` (повтор `commandId` с другим телом) и `UNKNOWN_AFTER_CRASH` не попадают в таблицу статусов в конце `src/server.mjs` и отдаются как `500`. Клиент с ретраями примет их за временную ошибку сервера и будет повторять. Нужно: `CONFLICT → 409`, `UNKNOWN_AFTER_CRASH → 409` (или `422`), плюс тест.

**Готово, когда:** контрактные тесты на все новые маршруты и схемы; тест «переподключение с `after` во время активного turn» — ни одного пропуска и дубля; тест «live-дельта с неверным `offset` игнорируется, финальное сообщение восстанавливает текст»; `apiVersion` и `capabilities` в `/api/info`. После этого контракт замораживается для KMP.

---

### B4. Несколько клиентов на одной сессии

- [ ] Prompt во время хода (сейчас: `now:false` → в `pendingPrompts`, `now:true` → прерывание). Добавить явный `mode`:
  - `queue` (по умолчанию, текущее поведение) → `prompt.queued`, затем `prompt.dispatched`;
  - `steer` → RPC `steer` в текущий ход;
  - `interrupt` → текущее `now: true`.
  Старый флаг `now` остаётся как синоним.
- [ ] UI-запросы расширений (по формату из B0) и существующие approvals — через одну таблицу `ui_requests`:
  - рассылаются всем подключённым клиентам и в push;
  - засчитывается первый ответ, остальным — `ui.resolved {resolvedBy: {clientId, clientKind}}`;
  - повторный ответ → `409 UI_REQUEST_RESOLVED`;
  - таймаут запроса — по политике расширения (у approvals уже есть локальный таймаут).
- [ ] `cancel` идемпотентный: второй `cancel` во время `CANCELLING` → `200` без побочных эффектов (проверить текущее поведение тестом).
- [ ] Presence: список `{clientId, clientKind, name, connectedAt}` по SSE-подключениям с `clientId`.
- [ ] Все пользовательские события помечены `source.kind` и `clientId`.

**Готово, когда:** тест с тремя виртуальными клиентами, одновременно отправляющими prompt, cancel и ответ на UI-запрос, даёт детерминированный результат и проходит 100 прогонов подряд.

---

### B5. Параллельные сессии и планировщик модели

> Решение не принято. [multi-session-queues.md](multi-session-queues.md) фиксирует «параллель сознательно не делаем» и оценивает работу в ~25 точек вокруг `activeTaskId`. Этот этап начинается только после отдельного решения; до него KMP работает с capacity=1 и показывает `waiting_model`.

- [ ] Шаг 1 (без изменения поведения): `activeTaskId: string` → `activeSlots: Set` с лимитом `N = 1`. Затронуты `#pump`/`#pumpOnce`, `reservedElsewhere`, `sendPendingNow`, `#interruptGeneration`, гейты cancel/compact, guard'ы рестарта модели/сервера.
- [ ] Шаг 2: лимиты в конфиге — глобальный и на провайдера; для llama.cpp по умолчанию `N = -np`.
- [ ] Шаг 3: ModelScheduler. Pi сам ходит к провайдеру, поэтому планировать можно только до отправки prompt (admission) — как сейчас. Если этого не хватит (Pi шлёт несколько запросов на ход), прокси перед endpoint'ом — отдельное решение.
- [ ] Прокси через браузер (qwen/deepseek local server): проверить, что параллельные запросы не сериализуются молча на одной странице Playwright; при необходимости — пул страниц.
- [ ] Детектор конфликта cwd: предупреждение при второй живой сессии в той же директории. Git worktree на сессию уже есть (`git.mjs`) — предлагать его в этом предупреждении.

**Готово, когда:** 4 параллельные сессии на fake-pi и 2 на реальной модели работают час без утечек процессов, без зависших `RUNNING` и с корректными `waiting_model`.

---

### B6. Жизненный цикл

- [ ] Idle-таймаут (30 мин / 2 ч / никогда), `pinned` отключает hibernate.
- [ ] Hibernate — команда в очереди сессии (B1): дождаться конца хода → `closeStdin` → ожидание → `killTree` → проверить, что процесса нет → `HIBERNATED`. Гонка «prompt во время засыпания» закрывается порядком в очереди.
- [ ] Auto-resume: prompt в `HIBERNATED`/`RESTORABLE` поднимает runtime с `--session` и отправляется после `LIVE`. Для `RESTORABLE` это уже работает («следующее сообщение поднимает Pi») — оформить через state machine.
- [ ] Reconciliation при старте: вместо `FAILED`/`FAILED_RECOVERY` — ход `FAILED` с `errorCode = RUNTIME_LOST`, runtime `RESTORABLE`. `FAILED_RECOVERY` остаётся в контракте как устаревший код до `v2`, веб-клиент переводится на `runtime.state`.
- [ ] Незавершённый ход после падения: показывать, что именно потеряно (последнее известное состояние хода), и предлагать «повторить последний prompt» (переиспользовать существующее «изменить и отправить заново»).

**Готово, когда:** chaos-тесты: kill daemon во время хода, перезагрузка ПК, prompt ровно в момент hibernate — после восстановления ни одной потерянной или задвоенной задачи; закрыт критерий 1.0 «аварийный рестарт больше не оставляет задачи в `FAILED_RECOVERY`».

---

### B7. Веб-клиент на новом контракте

- [ ] `displayState`, `runtime`, `presence`, UI-запросы расширений, `storeId`.
- [ ] Live-кадры вместо `message_update` из истории (если B2 выбрал этот путь): `web/chat-state.mjs` + тесты.
- [ ] Перевести на `Bearer`? Нет: браузер остаётся на cookie. Оба способа поддерживаются сервером.
- [ ] Удалить обработку `FAILED_RECOVERY` после перехода на `RESTORABLE`.

**Готово, когда:** все сценарии, работавшие до изменений, работают; DOM-тесты и [TEST_PLAN.md](../TEST_PLAN.md) зелёные.

---

### B8. CLI `taskbridge pi`

CLI — тонкий клиент API (так уже устроен `bin/taskbridge.mjs`), **не** запускает Pi сам.

- [ ] Команды:
  - `taskbridge pi` — attach к сессии текущего cwd (одна → сразу, несколько → выбор, нет → предложить `new`);
  - `taskbridge pi list`, `attach <id>`, `new`, `stop [<id>]`.
- [ ] Горячие клавиши: Ctrl+C во время хода → cancel хода; в простое → detach. Stop runtime — только явной командой.
- [ ] При attach — хвост истории (`?tail`) с метками источника («Earlier from Android»).
- [ ] Slash-команды (`/model`, `/thinking`, `/compact`) → существующие `POST /api/tasks/:id/model|thinking|compact`.
- [ ] UI-запросы расширений — интерактивно в терминале.
- [ ] Авторизация: CLI на той же машине ходит на loopback; при включённом auth — токен из `data/` (локальный доступ к файлу = доверие).
- [ ] Рендеринг: сначала проверить переиспользование `pi-tui`; свой рендерер — если не получится.
- [ ] `taskbridge attach` с фильтром провайдера — после B10.

**Готово, когда:** «терминал → detach → телефон пишет → attach в терминале» показывает всю историю и продолжает тот же PID Pi.

---

### B9. Внешние сессии

Уже есть: листинг по всем проектам, предпросмотр, clone (по умолчанию), take-over с `confirmedClosed`.

- [ ] View без импорта: `ownership = EXTERNAL_VIEW`, чтение JSONL, без runtime; любые команды → `423 EXTERNAL_SESSION`.
- [ ] Take-over без ручного подтверждения: проверить, что процесса Pi с этим `--session` нет (список процессов ОС), и что JSONL не менялся контрольный интервал; только затем запуск своего runtime (I9). Ручное `confirmedClosed` остаётся запасным путём.

**Готово, когда:** take-over невозможен, пока внешний процесс жив; clone не изменяет исходный JSONL (тест уже есть — проверить).

---

### B10. Задел под другие провайдеры

- [ ] Интерфейс `AgentProvider` (discover / start / resume / send / interrupt / stop / events) — развитие `runners/pi-runner.mjs` и `session-manager.mjs`, которые уже задуманы как этот слой.
- [ ] Pi реализован через него без изменения контракта.
- [ ] Приоритет транспорта для Codex/Claude: нативный структурированный протокол → headless/RPC-режим CLI → PTY как fallback.

---

## 5. Тестовая стратегия

Опирается на существующий набор (`npm test`, ~500 проверок на `node:test`).

- **Unit:** state machine (все переходы из таблицы и отказ на остальных), `displayState`, парсер stdout, выдача `seq`, нормализатор событий.
- **Интеграционные на fake-pi:** все fixtures из B0.
- **Контрактные:** `api-contract.test.mjs` + проверка ответов по JSON Schema. **Эти же fixtures и схемы публикуются для KMP** (`docs/schema/`, `tests/fixtures/api/`) — это главный канал синхронизации двух команд.
- **Chaos-набор (перед релизом):** kill Pi посреди tool call; kill daemon посреди хода; обрыв SSE и переподключение с `after`; двойной prompt с одним `commandId`; prompt во время hibernate; три клиента одновременно; восстановление БД из бэкапа (I10).
- **Soak (ночь, реальная модель):** утром — ноль сирот, ноль вечных `RUNNING`, рост БД в ожидаемых пределах (`npm run stress` с `TASKBRIDGE_STRESS_SECONDS`).
- Каждый баг, найденный руками, сначала превращается в тест, потом чинится.

## 6. Логи

- В каждой строке: `sessionId`, `seq` (если есть), `clientId` (если есть), `runtime.state`.
- Отдельный лог stdout/stderr Pi на сессию, с ротацией (сейчас `pi.stderr.log` и `pi-events.jsonl` без ротации).

## 7. Открытые вопросы

Закрыть в B0:
- [ ] Формат extension UI-запросов Pi в RPC-режиме и как на них отвечать.
- [ ] Блокирует ли Pi session JSONL при записи — влияет на B9.
- [ ] Job Object на Windows: нативный helper или обёртка.
- [ ] Можно ли переиспользовать `pi-tui` в CLI.

Решить до заморозки контракта (B3):
- [ ] Live-кадры без `seq` или текущий `message_update` + trim.
- [ ] Нужен ли WebSocket вообще. Аргумент «за» — одно соединение на несколько сессий у мобильного клиента; «против» — SSE уже работает и проверен. Предложение: SSE + `/api/stream` для списка, WS не делать.

Отдельное продуктовое решение:
- [ ] Параллельные сессии (B5) — входит ли в 1.0.

## 8. Порядок и зависимости

```
B0 → B1 → B2 → B3 ──(заморозка контракта)──┬─→ B4 ─┬─→ B7 (web)
                                           │       ├─→ B8 (CLI)
                                           │       └─→ KMP K2+ (см. отдельный план)
                                           └─→ B6 → B9 → B10
                              B5 — после отдельного решения, в любой точке после B4
```

Изменения относительно первой редакции:
- B6 (hibernate, `RESTORABLE`) поставлен раньше B5: он закрывает критерий 1.0 из README и нужен KMP для честных состояний, а B5 — нет.
- Контракт B3 включает **поля** `runtime.state`/`displayState` со всеми значениями, даже если `HIBERNATED` начнёт появляться только после B6, — чтобы не менять контракт после заморозки.

Этапы B1–B3 дают основную часть надёжности; их не стоит торопить ради клиентов.

### Связь с roadmap 1.0

README ставит KMP-клиент после 1.0 (после Claude/Codex runner'ов). Этот план этого не меняет, но делит работу так:

- **входит в 1.0:** B0, B1, B2, B6 (закрывают «стабильное ядро» и `FAILED_RECOVERY`), B3 в части «HTTP API и контракт `TaskEvent` объявлены стабильными»;
- **после 1.0:** B4, B5, B7–B10 и весь KMP-план.

Если приоритеты другие (KMP раньше runner'ов) — достаточно поменять порядок в README; сам план от этого не меняется.
