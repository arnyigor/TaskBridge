# TaskBridge

**Пульт управления локальным coding-агентом Pi с телефона по Wi‑Fi.**

TaskBridge — это небольшой локальный HTTP/PWA-сервер, который запускается на компьютере рядом с проектом и даёт с телефона:

- поставить задачу выбранной модели в выбранном проекте;
- видеть в реальном времени, что делает агент (tools, streaming, статусы);
- остановить выполнение кнопкой `STOP`;
- дописать/уточнить задачу в живую сессию (follow-up / steering);
- сжать контекст (`COMPACT`) и посмотреть состояние Pi;
- открыть историю сессий, вложения и артефакты результата.

Главная идея:

```text
Телефон → Wi‑Fi → TaskBridge → Pi RPC → выбранная модель → проект
                        ↓
                live events / STOP /
                follow-up / compact
```

Это рабочий proof-of-concept. TaskBridge не содержит собственного агента и не вмешивается в настройки провайдера модели — он запускает тот же `pi --mode rpc`, которым вы пользуетесь вручную, и работает поверх его JSONL-протокола.

---

## Содержание

- [Возможности](#возможности)
- [Технологии](#технологии)
- [Хранилище (SQLite)](#хранилище-sqlite)
- [Архитектура](#архитектура)
- [Структура проекта](#структура-проекта)
- [Требования](#требования)
- [Быстрый старт](#быстрый-старт)
- [Добавление проекта](#добавление-проекта)
- [Конфигурация](#конфигурация)
- [HTTP API](#http-api)
- [Данные и артефакты](#данные-и-артефакты)
- [Git worktree](#git-worktree)
- [Применение изменений и очистка](#применение-изменений-и-очистка)
- [STOP, follow-up, compact, Pi state](#stop-follow-up-compact-pi-state)
- [Файлы с телефона](#файлы-с-телефона)
- [Cloud transport (remote access)](#cloud-transport-remote-access)
- [Local Runtime Manager](#local-runtime-manager)
- [AUTO dispatcher](#auto-dispatcher)
- [Engine health](#engine-health)
- [Cloud bridge (Vercel Queues)](#cloud-bridge-vercel-queues)
- [Безопасность](#безопасность)
- [Тесты](#тесты)
- [Известные ограничения](#известные-ограничения)
- [Roadmap](#roadmap)

---

## Возможности

### Управление задачами

- список зарегистрированных проектов и Scratch workspace без проекта;
- регистрация проекта из UI через встроенный браузер папок;
- удаление и переименование сессий;
- текстовая задача + небольшие вложения с телефона;
- постановка задачи в очередь и запуск `pi --mode rpc` в правильном `cwd`;
- строгий LF-JSONL parser протокола Pi RPC;
- live Pi events через SSE (Server-Sent Events);
- streaming assistant output, tool start/end, статусы задачи;
- `STOP` через RPC `clear_queue` + `abort` с fallback на kill дерева процессов;
- follow-up / steering в живую Pi-сессию;
- `COMPACT` через Pi RPC и статистика сжатия, когда Pi её отдаёт;
- `get_state` — модель, thinking level, streaming/compacting, id сессии;
- переключатель auto compaction;
- импорт уже существующих Pi-сессий как задач TaskBridge: кнопка «Импорт сессии Pi» показывает найденные сессии всех проектов с поиском и предпросмотром, а по умолчанию делает **безопасную копию** (оригинал в терминале не трогается); режим «забрать оригинал» — отдельно, с подтверждением;
- постраничная (turn-aligned) загрузка истории длинных сессий;
- у каждой сессии свой адрес `/session/<id>`: обновление страницы, закладка и ссылка на другом устройстве открывают тот же разговор (сервер отдаёт SPA-оболочку для таких путей);
- экран сессий делит список на «Активные» и «Недавние», в строке — статус, проект, модель и относительное время обновления, кнопка 🔗 копирует ссылку на сессию;
- очередь с capacity=1: если локальная модель занята (другой клиент, чужая сессия, залипший слот), промпт **не теряется** — задача/сообщение встаёт в очередь («ждёт модель»), отправляется автоматически при освобождении модели и переживает перезапуск TaskBridge;
- как в современных чатах: `Enter` — поставить в очередь (даже если модель свободна: сессия подхватит сразу), `Ctrl+Enter` (Cmd+Enter) — отправить немедленно, не дожидаясь модели; сообщения в очереди видны над полем ввода (с количеством) и у каждого есть «Отправить сейчас» и «Убрать»; несколько сообщений к одной сессии ждут своей очереди по порядку и не теряются.

### Интерфейс

- локальный веб-UI, адаптированный под телефон;
- PWA (`manifest.webmanifest`, standalone), без внешних библиотек и CDN;
- Markdown и код в ответах (vendored `marked` + `DOMPurify`);
- сворачиваемые секции, чтобы длинный чат не растягивал экран;
- скачивание вложений и файлов workspace;
- просмотр артефактов задачи.

### Инфраструктура

- persistent-хранилище задач и событий в SQLite (встроенный `node:sqlite`, без нативных зависимостей);
- потоковая загрузка файлов (multipart, без base64);
- `git status`, `git diff`, `diff.patch`;
- изолированный `git worktree` на задачу, применение результата и очистка worktree;
- project-specific verification commands;
- проверка здоровья локального llama.cpp endpoint и managed-запуск профилей `text` / `vision`;
- AUTO-выбор профиля модели под задачу и классификация ошибок движка (quota / rate limit / context);
- опциональная авторизация по pairing-коду и self-signed HTTPS для LAN.

---

## Технологии

| Слой | Что используется |
| --- | --- |
| Runtime | Node.js 22.13+, ESM (`.mjs`), без сборки и транспиляции |
| Backend | стандартный `node:http`, `node:child_process`, `node:crypto`, `node:fs/promises` |
| Агент | Pi CLI в режиме `--mode rpc` (JSONL over stdio) |
| Транспорт UI | HTTP + SSE |
| Frontend | нативный HTML/CSS/JS, PWA, без фреймворков |
| Markdown | `marked` + `DOMPurify` (лежат в `web/vendor`, без CDN) |
| Тесты | встроенный `node:test` + `linkedom` для DOM-тестов |
| Хранилище | SQLite через встроенный `node:sqlite` (`data/taskbridge.db`, WAL) |

---

## Архитектура

```text
┌──────────────┐   HTTP / SSE    ┌──────────────────────────────────────┐
│  Телефон     │ ───────────────▶│  TaskBridge (Node.js, node:http)     │
│  браузер/PWA │◀─────────────── │                                      │
└──────────────┘   live events   │  server.mjs      HTTP API + static   │
                                 │  task-manager    жизненный цикл      │
                                 │  pi-rpc.mjs      JSONL RPC клиент    │
                                 │  task-store.mjs  события/метаданные  │
                                 │  git.mjs         worktree, diff      │
                                 │  runtime-manager llama.cpp health    │
                                 │  auth.mjs / tls.mjs  pairing, HTTPS  │
                                 └───────────────┬──────────────────────┘
                                                 │ stdio (JSONL)
                                                 ▼
                                 ┌──────────────────────────────────────┐
                                 │  pi --mode rpc  (cwd = workspace)    │
                                 │            ↓                         │
                                 │  выбранная модель / provider         │
                                 └──────────────────────────────────────┘
```

TaskBridge — тонкая прослойка: он не переписывает логику агента, а транслирует события Pi в SSE, хранит их и добавляет управление (STOP, follow-up, compact, worktree, артефакты).

---

## Структура проекта

```text
Taskbridge/
├─ src/
│  ├─ server.mjs            HTTP-сервер, роутинг API, SSE, раздача статики
│  ├─ task-manager.mjs      жизненный цикл задач, очередь, сообщения, Pi-сессии
│  ├─ pi-rpc.mjs            запуск Pi и JSONL RPC-клиент
│  ├─ task-store.mjs        SQLite-хранилище задач и событий
│  ├─ multipart.mjs         потоковый парсер multipart/form-data
│  ├─ uploads.mjs           стейджинг загрузок с TTL
│  ├─ engine.mjs            классификация ошибок провайдера (quota/rate limit/context)
│  ├─ dispatcher.mjs        AUTO-выбор профиля/модели
│  ├─ local-models.mjs      llama.cpp router: процесс, /models, load/unload, прогресс
│  ├─ model-catalog.mjs     список моделей Pi (get_available_models)
│  ├─ pi-settings.mjs       чтение ~/.pi/agent/settings.json (blockImages)
│  ├─ mcp-manager.mjs       MCP для задач: свой конфиг, вкл/выкл, import из Pi
│  ├─ session-history.mjs   восстановление истории после restart
│  ├─ native-sessions.mjs   импорт существующих Pi-сессий
│  ├─ pi-session-index.mjs  безопасный поиск/чтение файлов сессий Pi
│  ├─ event-trim.mjs        отбрасывание устаревших streaming-дельт
│  ├─ event-window.mjs      постраничная выдача истории по turn'ам
│  ├─ git.mjs               worktree, status, diff, patch
│  ├─ files.mjs             вложения, лимиты, безопасные пути
│  ├─ runtime-manager.mjs   health-check и запуск llama.cpp
│  ├─ runtime-control.mjs   профили runtime, start/restart/status
│  ├─ project-browser.mjs   браузер папок для регистрации проектов
│  ├─ auth.mjs              pairing-код, cookie, rate limit
│  ├─ tls.mjs               self-signed сертификат для LAN HTTPS
│  ├─ config.mjs            загрузка/сохранение config.json
│  ├─ domain/               протокол: TaskEvent, CloudCommand, machine state
│  ├─ events/               EventMux, sequence, нормализация, snapshot'ы
│  └─ cloud/                CloudWorker, outbox, heartbeat, dispatcher, approvals
├─ pi-extension/            Pi-расширение: подтверждение опасных tool-вызовов
├─ cloud/                   облачный control plane (Vercel-совместимый)
│  ├─ lib/                  роутер API, auth, store (memory/sqlite/postgres), errors, ids
│  ├─ api/index.mjs         Vercel function (общий роутер)
│  └─ server.mjs            локальный хост облака + SSE (раздаёт тот же web/)
├─ api/index.mjs            Vercel-энтрипоинт (реэкспорт cloud/api)
├─ .vercelignore            исключает config.json/data из CLI-деплоя
├─ vercel.json              конфиг Vercel (outputDirectory: web — один UI)
├─ web/
│  ├─ index.html            разметка UI
│  ├─ app.js                логика UI, SSE, рендер чата
│  ├─ chat-state.mjs        чистое состояние чата (тестируемое)
│  ├─ app.css               стили
│  ├─ manifest.webmanifest  PWA-манифест
│  └─ vendor/               marked, DOMPurify и их лицензии
├─ tests/                   216 тестов на node:test
├─ scripts/
│  ├─ pi-rpc-smoke.mjs      smoke-тест Pi RPC
│  ├─ cloud-secrets.mjs     генерация токенов/секретов (npm run cloud:secrets)
│  ├─ cloud-deploy.mjs      автодеплой на Vercel (npm run cloud:deploy)
│  ├─ check-secrets.mjs     аудит утечек (npm run check:secrets)
│  └─ backup.mjs            снимок БД (npm run backup)
├─ docs/                    ТЗ, ревью и планы
├─ config.example.json      шаблон конфигурации
├─ models.example.ini       шаблон пресетов llama.cpp router (скопируйте в models.ini)
├─ start.cmd                запуск на Windows
└─ data/                    задачи, события, worktree, логи (не в git)
```

---

## Требования

- Windows 10/11 (основная целевая платформа);
- Node.js 22.13+ (нужен встроенный модуль `node:sqlite`);
- Git — если проверяется Git-проект;
- Pi CLI в `PATH`;
- настроенный в Pi provider/model;
- для локальной модели — работающий llama.cpp endpoint либо managed-запуск.

Проверка:

```powershell
node --version
git --version
pi --version
```

Если Pi не установлен:

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

---

## Быстрый старт

### 1. Сначала проверить Pi отдельно

TaskBridge не должен одновременно отлаживать и Pi, и модель. Из папки проекта:

```powershell
pi -p "Ответь только PI_OK"
```

Если это не работает — сначала настроить Pi/model provider.

RPC smoke-тест:

```powershell
npm run smoke:pi -- "G:\path\to\project"
```

Успешный конец:

```text
[smoke] PI_RPC_OK: agent_settled received
```

### 2. Запустить TaskBridge

```powershell
start.cmd
```

При первом старте автоматически создаётся `config.json` из `config.example.json`. Сервер напечатает:

```text
TaskBridge MVP listening on 0.0.0.0:8787
Local: http://127.0.0.1:8787
LAN (Wi-Fi): http://192.168.1.42:8787
```

На телефоне в той же Wi‑Fi сети открыть LAN URL.

### 3. Самая быстрая проверка без проекта

В UI выбрать `Project: Scratch workspace` и отправить:

```text
Создай файл hello.txt со строкой TaskBridge works. Затем прочитай его и сообщи результат.
```

На телефоне должны появиться live Pi events.

### 4. Настройка Pi для локальной модели

TaskBridge не вмешивается в model provider Pi. Простейший путь:

1. открыть `pi`;
2. настроить provider/model;
3. сохранить как default;
4. убедиться, что `pi -p ...` работает;
5. оставить `config.pi.args` пустым.

Явные флаги при необходимости:

```json
"pi": {
  "command": "pi",
  "args": ["--provider", "YOUR_PROVIDER", "--model", "YOUR_MODEL", "--thinking", "medium"]
}
```

Для OpenAI-совместимого single-model llama.cpp endpoint настройте custom provider в `~/.pi/agent/models.json`. Для llama.cpp router в Pi есть `/login llama.cpp`.

**Практический критерий:** если команда ниже работает из нужной папки, TaskBridge использует те же настройки:

```powershell
pi -p "Прочитай README проекта и ответь одной строкой"
```

---

## Добавление проекта

Вариант 1 — через UI: кнопка регистрации проекта открывает браузер папок, разрешённых в `projectBrowser.roots`.

Вариант 2 — вручную в `config.json`:

```json
{
  "projects": [
    {
      "id": "my-project",
      "name": "My Project",
      "path": "G:\\Projects\\MyProject",
      "useWorktree": true,
      "verification": [".\\gradlew.bat test --console=plain"]
    }
  ]
}
```

После правки вручную — перезапустить TaskBridge. Изменения, сделанные через UI (регистрация/удаление проекта), сохраняются в `config.json` автоматически.

---

## Конфигурация

Шаблон — `config.example.json`. Ключевые поля:

| Ключ | Назначение |
| --- | --- |
| `server.host` / `server.port` | адрес и порт HTTP-сервера (по умолчанию `0.0.0.0:8787`) |
| `server.maxBodyMb` | максимальный размер JSON-тела запроса |
| `server.maxUploadMb` | лимит одного файла при потоковой загрузке (суммарно — 2×) |
| `server.maxEventsPerRequest` | потолок событий на один HTTP-запрос (по умолчанию 20000) |
| `server.sqlite.synchronous` | `NORMAL` (быстро) или `FULL` (выживает жёсткое отключение) |
| `server.sqlite.busyTimeoutMs` | сколько ждать занятую БД (по умолчанию 5000) |
| `server.auth.enabled` | включить pairing-авторизацию |
| `server.https.enabled` / `port` | self-signed HTTPS для LAN |
| `pi.command` / `pi.args` | как запускать Pi |
| `pi.env` | дополнительные env-переменные Pi (TaskBridge сама добавляет `LLAMA_BASE_URL` в router-режиме) |
| `pi.mcp.mode` | MCP для задач: `inherit` (как в Pi), `managed` (свой конфиг TaskBridge), `off` (без MCP) |
| `pi.mcp.configPath` | путь к своему MCP-конфигу (по умолчанию `data/mcp.json`) |
| `pi.persistSessions` | сохранять файлы сессий Pi |
| `pi.projectTrust` | доверие проекту в Pi |
| `pi.abortTimeoutMs` | сколько ждать RPC `abort` до kill |
| `pi.sessionRoots` | дополнительные папки сессий Pi для импорта |
| `localRuntime.healthUrl` | health-check локальной модели |
| `localRuntime.provider` | provider Pi, который обслуживает локальный runtime (по умолчанию `llama.cpp` в router-режиме, иначе `llamacpp`); для других provider'ов локальный health-check пропускается || `localRuntime.router` | router-режим llama.cpp: `enabled`, `command`, `args`, `cwd`, `env`, `startTimeoutMs`, `loadTimeoutMs` |
| `localRuntime.profiles` | (legacy) профили одного процесса (`text`, `vision`, …) |
| `localRuntime.managed` | управляемый запуск llama.cpp |
| `localRuntime.auto.enabled` | AUTO-выбор профиля под задачу (vision при картинках) |
| `cloud.enabled` / `cloud.url` | включить Internet bridge и указать Vercel deployment |
| `cloud.machineId` / `machineSecretEnv` | идентификатор ПК и имя env-переменной с machine secret |
| `workspace.requireCleanSource` | запрещать старт на dirty source repository |
| `workspace.useGitWorktreeByDefault` | изолировать задачу в worktree |
| `projectBrowser.roots` | корни, которые видит браузер папок |
| `projects[]` | зарегистрированные проекты |

`config.json` в git не хранится — он содержит локальные пути.

---

## HTTP API

Все `/api/*`, кроме `auth`/`health`, требуют авторизацию, если она включена.

| Метод | Путь | Назначение |
| --- | --- | --- |
| `GET` | `/api/health` | liveness |
| `GET` | `/api/auth` | статус авторизации |
| `POST` | `/api/auth/pair` | вход по pairing-коду |
| `GET` | `/api/auth/pairing` | текущий код (только с localhost) |
| `GET` | `/api/info` | имя, build, адреса, готовность модели, engine health, лимиты файлов |
| `POST` | `/api/uploads` | потоковая multipart-загрузка файлов |
| `GET` | `/api/projects` | список проектов |
| `DELETE` | `/api/projects/:id` | удалить проект |
| `GET` | `/api/project-browser` | список папок в разрешённых корнях |
| `POST` | `/api/project-browser/register` | зарегистрировать проект |
| `GET` | `/api/projects/:id/pi-sessions` | существующие Pi-сессии проекта |
| `GET` | `/api/native-sessions` | сессии всех проектов, сгруппированы, с подсказкой недавней |
| `GET` | `/api/native-sessions/preview` | предпросмотр сессии: модель, thinking, размер, последние сообщения |
| `GET` | `/api/models` | список доступных моделей Pi (`?refresh=1` — заново опросить Pi) |
| `GET` | `/api/tasks` | список сессий/задач |
| `POST` | `/api/tasks` | создать задачу |
| `POST` | `/api/tasks/from-session` | импортировать Pi-сессию (`mode: clone` по умолчанию, `take-over` — с `confirmedClosed`) |
| `GET` / `DELETE` / `PATCH` | `/api/tasks/:id` | получить / удалить / переименовать |
| `GET` | `/api/tasks/:id/events` | события (`after`, `limit`, `tail`, `before`) |
| `GET` | `/api/tasks/:id/stream` | SSE-поток live events |
| `GET` | `/api/tasks/:id/state` | состояние Pi |
| `POST` | `/api/tasks/:id/message` | follow-up / steering |
| `POST` | `/api/tasks/:id/cancel` | STOP |
| `POST` | `/api/tasks/:id/compact` | COMPACT |
| `POST` | `/api/tasks/:id/auto-compaction` | вкл/выкл auto compaction |
| `POST` | `/api/tasks/:id/model` | сменить модель сессии (как `/model` в Pi) |
| `POST` | `/api/tasks/:id/thinking` | задать thinking level сессии |
| `GET` | `/api/tasks/:id/artifacts` | список артефактов |
| `GET` | `/api/tasks/:id/artifacts/:name` | скачать артефакт |
| `GET` | `/api/tasks/:id/files/:id` | скачать вложение |
| `GET` | `/api/tasks/:id/workspace-file?path=` | файл из workspace |
| `POST` | `/api/tasks/:id/apply` | применить `diff.patch` к исходному проекту |
| `DELETE` | `/api/tasks/:id/worktree` | удалить worktree задачи |
| `GET` | `/api/runtime` | статус локальной модели (legacy-профили) |
| `POST` | `/api/runtime/start` / `restart` | запустить/перезапустить профиль (legacy) |
| `GET` | `/api/local` | статус router-режима: state, pid, список локальных моделей |
| `POST` | `/api/local/load` | загрузить локальную модель (`{ "model": "id" }`) |
| `POST` | `/api/local/unload` | выгрузить локальную модель |
| `POST` | `/api/local/stop` | остановить router (только если его запустил TaskBridge) |
| `GET` | `/api/local/events` | SSE: статус и прогресс загрузки локальных моделей |
| `GET` | `/api/mcp` | MCP-серверы и режим (`inherit` / `managed` / `off`) |
| `POST` | `/api/mcp/mode` | сменить режим MCP |
| `POST` | `/api/mcp/import` | импортировать MCP-конфиг из Pi |
| `POST` | `/api/mcp/servers` | включить/выключить сервер (`{ name, enabled }`) |
| `POST` | `/api/mcp/tools` | включить/выключить один инструмент (`{ server, tool, enabled }`) |

---

## Данные и артефакты

```text
data/
├─ taskbridge.db            SQLite: задачи (tasks) и события (events)
├─ taskbridge.db-wal/-shm   WAL-журнал SQLite
├─ taskbridge.lock          признак запущенного экземпляра (pid)
├─ backups/                 снимки БД от `npm run backup`
├─ tasks/<task-id>/
│  ├─ files/                вложения
│  └─ artifacts/
│     ├─ result.md
│     ├─ result.json
│     ├─ diff.patch
│     ├─ git-status.txt
│     ├─ pi-events.jsonl
│     ├─ pi.stderr.log      (если был stderr)
│     ├─ verification.log   (если настроена verification)
│     ├─ apply.log          (если изменения применялись)
│     └─ runtime.log        (если TaskBridge запускал runtime)
├─ worktrees/<task-id>/     изолированный checkout
├─ uploads/<token>/         стейджинг потоковых загрузок (удаляется/TTL)
├─ pi-sessions/             сессии Pi
├─ server-auth.json         секрет pairing (если auth включён)
└─ tls/                     self-signed сертификаты
```

Вложения, отправленные с телефона, попадают в `.taskbridge-input/` внутри workspace, а к prompt добавляется список путей.

### Хранилище (SQLite)

Задачи и события лежат в `data/taskbridge.db` (режим WAL, `synchronous = NORMAL`). Схема минимальна:

| Таблица | Содержимое |
| --- | --- |
| `tasks` | `id`, `created_at`, `updated_at` + `data` (JSON задачи с ограниченным хвостом текста) |
| `events` | `task_id`, `seq`, `payload` (JSON события), PK `(task_id, seq)`, FK → `tasks(id) ON DELETE CASCADE` |
| `meta` | служебные отметки, в том числе факт миграции |

- Полный JSON в колонках `data`/`payload` сохраняет контракт HTTP API неизменным при эволюции полей.
- `seq` монотонен в пределах задачи и выдаётся атомарно, поэтому SSE-курсоры (`Last-Event-ID`) не ломаются при конкурентной записи.
- `assistantText`/`thinkingText` в задаче — только хвост (64 КБ / 16 КБ); полная история живёт в событиях и нативной сессии Pi. Старые записи ужимаются один раз при старте + `VACUUM`.
- Стриминговые дельты (`message_update`), уже закрытые `message_end`, удаляются при записи — длинная сессия не копит мегабайты мёртвых событий.
- FK с `ON DELETE CASCADE` + удаление в транзакции — удаление задачи и её событий атомарно, осиротевшие события невозможны.
- Схема версионируется через `PRAGMA user_version`; старые базы без FK пересобираются один раз при старте.
- Снимок БД: `npm run backup` → `data/backups/taskbridge-<timestamp>.db` (`VACUUM INTO`, сервер можно не останавливать), хранятся последние 5. При закрытии и в бэкапе WAL схлопывается (`wal_checkpoint(TRUNCATE)`).
- `PRAGMA synchronous`/`busy_timeout` настраиваются в `server.sqlite`.
- Файлы (вложения, артефакты, worktree, Pi-сессии) остаются на диске — в БД только метаданные и события.
- При удалении задачи удаляются также её worktree, `.taskbridge-input/<id>`, `data/pi-sessions/<id>` и `data/workspaces/<id>`; при старте подчищаются сироты.
- Один экземпляр на data-каталог: `data/taskbridge.lock` с pid, устаревший lock мёртвого процесса перехватывается.
- При первом запуске на старой установке `data/tasks/<id>/task.json` и `events.jsonl` автоматически импортируются один раз (отметка в `meta`), битые хвостовые строки пропускаются.

---

## Git worktree

По умолчанию AI **не работает в основном checkout**. TaskBridge создаёт

```text
data/worktrees/<task-id>/
```

и запускает Pi там, поэтому исходный проект остаётся нетронутым.

Dirty source repository по умолчанию блокируется:

```json
"workspace": {
  "requireCleanSource": true,
  "useGitWorktreeByDefault": true
}
```

Для теста проверку можно отключить, но это не рекомендуется.

### Применение изменений и очистка

- `POST /api/tasks/:id/apply` применяет `diff.patch` к исходному checkout. По умолчанию требует чистый source и тот же HEAD, что при создании worktree (`PROJECT_DIRTY` / `SOURCE_MOVED`); `{"force": true}` снимает проверки. `git apply --check` выполняется до записи, поэтому конфликт ничего не портит.
- `DELETE /api/tasks/:id/worktree` закрывает idle-сессию Pi и удаляет worktree (`git worktree remove --force` + `prune`); удаление задачи тоже чистит её worktree.
- Apply меняет только рабочее дерево, коммит не создаётся.

---

## STOP, follow-up, compact, Pi state

### STOP

1. очищает queued steering/follow-up;
2. отправляет Pi RPC `abort`;
3. ждёт остановки (`pi.abortTimeoutMs`);
4. если abort завис — убивает дерево процессов Pi;
5. сохраняет частичный Git diff;
6. задача получает `CANCELLED`.

### Follow-up / steering

Поле под кнопками отправляет инструкцию в живую сессию. В режиме `auto`:

- если Pi streaming — используется `steer`;
- если Pi idle — отправляется новый `prompt` в ту же session.

После завершения follow-up verification выполняется повторно.

### COMPACT

TaskBridge отправляет RPC `{"type":"compact"}` и может показать статистику вида `1 · 51832 → 19416`. `estimatedTokensAfter` — оценка Pi, а не точный счётчик провайдера. Своего сжатия TaskBridge не делает.

### PI STATE

RPC `get_state`: текущая модель, thinking level, `isStreaming`, `isCompacting`, id/файл сессии, auto compaction, количество сообщений и pending. Точный размер контекста не выдумывается, если Pi его не отдаёт.

### Model switching (как в Pi)

Список моделей TaskBridge берёт напрямую у Pi: `GET /api/models` поднимает короткоживущий `pi --mode rpc --no-session`, спрашивает `get_available_models` / `get_available_thinking_levels` и кэширует ответ (по умолчанию 60 c). Поэтому видны все provider'ы Pi — не только локальные llama.cpp-профили, но и удалённые (`ollama`, OpenAI-совместимые и т.д.), ровно как в `/model`.

- новая задача: `POST /api/tasks` принимает `model: { provider, id }` и `thinkingLevel`; TaskBridge передаёт их Pi как `--provider/--model/--thinking` поверх `pi.args`;
- живая сессия: `POST /api/tasks/:id/model` вызывает RPC `set_model` (и `set_thinking_level` для `/thinking`). Pi пишет смену в транскрипт сессии, поэтому она переживает restart TaskBridge;
- если задача ещё не запускалась, смена модели поднимет/восстановит Pi-сессию.

Локальный health-check и переключение профиля применяются только к провайдеру `localRuntime.provider` (по умолчанию `llamacpp`). Для остальных провайдеров они пропускаются, поэтому удалённая модель работает даже при остановленном локальном llama.cpp.

Pi знает два id одного и того же локального эндпоинта: рукописный провайдер `llamacpp` и встроенный `llama.cpp` (последний требует `LLAMA_BASE_URL` и без него отвечает «Provider is not configured»). Поэтому id, который TaskBridge передаёт в Pi, сверяется с каталогом Pi: если настроенного id у Pi больше нет, подставляется тот локальный id, который Pi действительно отдаёт. Подробности и правила именования — [docs/local-model-providers.md](docs/local-model-providers.md).

---

## Файлы с телефона

Файлы загружаются потоково через `POST /api/uploads` (`multipart/form-data`, без base64), поэтому размер ограничен не JSON-телом, а лимитами загрузки. UI отправляет файлы этим запросом, получает `{ token, files: [{ id, name, size, mimeType }] }` и передаёт только `id` в `POST /api/tasks` или `/api/tasks/:id/message` вместе с `uploadToken`. Клиентские имя/размер не принимаются на веру — они берутся из того, что реально записано на диск.

| Лимит | По умолчанию | Где |
| --- | --- | --- |
| Файлов за раз | 10 | `FILE_LIMITS.count` |
| Размер одного файла | 64 MiB | `server.maxUploadMb` |
| Суммарно | 128 MiB | 2× `server.maxUploadMb` |
| JSON-тело (inline base64) | 25 MiB | `server.maxBodyMb` |

Стейджинг лежит в `data/uploads/<token>/` и удаляется после того, как файл попал в задачу, либо по TTL (1 час) для заброшенных загрузок. Встроенный base64 всё ещё принимается для совместимости, но ограничен `server.maxBodyMb`.

Multipart — CORS-«простой» content-type, поэтому запрос дополнительно требует заголовок `x-taskbridge-upload: 1`: кросс-сайтовый `<form>` его выставить не может без preflight, который сервер не разрешает.

---

## Cloud transport (remote access)

Опциональный облачный control plane: удалённое управление и наблюдение за
локальными задачами Pi с телефона через интернет — без port forwarding, публичного
IP, VPN и без длительных Vercel-запросов. Локальный runtime остаётся единственным
исполнителем, облако — только транспорт, аутентификация и durable-хранилище.

```text
Телефон / PWA ──HTTPS/SSE──► Vercel (или npm run cloud)
                                ▲               │ команды
                         события│               ▼
                                └── TaskBridge (исходящие соединения) → Pi
```

Текущее состояние работ и что проверено — [`docs/cloud-transport-status.md`](docs/cloud-transport-status.md).

Деплой одной командой: `npm run cloud:deploy -- --project <name> --database-url "postgres://…"`
(генерирует креды, ставит env в Vercel, деплоит, проверяет `/api/health` и что
хранилище durable). GitHub для этого не нужен: CLI деплоит локальный каталог;
для автодеплоя по push добавьте `--git` (подключит репозиторий и не будет
деплоить вручную). Перед деплоем/пушем: `npm run check:secrets` — проверяет, что
секреты и локальные данные не попадут ни в `vercel deploy` (он не читает
`.gitignore`), ни в коммит. Только секреты: `npm run cloud:secrets -- --url https://<project>.vercel.app`.
Полная пошаговая инструкция (ручной путь через дашборд, диагностика, ротация) —
[`docs/cloud-deploy-vercel.md`](docs/cloud-deploy-vercel.md).

Режимы (`Tech_next_version.md` §6): **local-only** (по умолчанию, облако не нужно),
**cloud-only** (только исходящие соединения машины) и **hybrid** (LAN и облако
одновременно видят одни и те же задачи).

Что реализовано локально: нормализованные `TaskEvent` со строго монотонным `seq`
(сохраняется между restart'ами), `EventMux`, батчинг дельт с coalescing,
приоритеты событий, durable outbox с backpressure, heartbeat, polling команд,
идемпотентность `commandId`, reconnect с backoff 1s→30s, reconcile при старте,
redaction секретов и путей, метрики (`/api/metrics`, в т.ч. Prometheus), экран
настроек облака, диагностика `/debug/cloud`.

Дополнительно (Этап A): **подтверждения опасных tool-вызовов** работают
по-настоящему — Pi-расширение блокирует `tool_call` до ответа оператора локально
или с телефона, состояние задачи `WAITING_USER`, таймаут и fail-closed;
**ограничение вывода инструментов** (полный лог остаётся на машине, в облако идёт
rolling-окно и по запросу — ограниченный срез через `FETCH_TOOL_OUTPUT`);
**SET_MODEL / SET_THINKING** через реальные RPC-команды Pi (`set_model`,
`set_thinking_level`).

Что реализовано в облаке: аутентификация пользователя и машины, реестр машин,
задачи и их состояния, очередь команд с приоритетами, durable-события с
дедупликацией `(taskId, seq)`/`eventId`, replay `?after=`, approvals, retention,
PWA с живым стримингом ответа, tool-карточками, STOP / follow-up / compact и
индикаторами Cloud / Machine / Realtime / Task.

Включение — в `config.json`:

```jsonc
"cloud": {
  "enabled": true,
  "url": "https://taskbridge.example.app",
  "machineId": "home-pc-01",
  "machineSecret": "<secret>"
}
```

или переменными окружения `TASKBRIDGE_CLOUD_ENABLED`, `TASKBRIDGE_CLOUD_URL`,
`TASKBRIDGE_MACHINE_ID`, `TASKBRIDGE_MACHINE_SECRET` (перекрывают config.json).
Запуск облака локально: `npm run cloud` (по умолчанию sqlite в `cloud/data/`).

Гарантии: закрытый браузер, обрыв интернета на телефоне или на рабочей станции,
падение облака и новый деплой Vercel не теряют вывод — клиент хранит
`lastReceivedSeq` и дозабирает события, а машина копит их в outbox. Задача может
идти часами: ни один HTTP-запрос не удерживается открытым.

Полная документация, API и список известных пробелов (WebSocket-фастпас,
Postgres-адаптер) — в [`docs/cloud-transport.md`](docs/cloud-transport.md).
Текущая переделка облака: протокол — [`docs/cloud-protocol.md`](docs/cloud-protocol.md), решение по хранилищу — [`docs/cloud-integration-decision.md`](docs/cloud-integration-decision.md), сведение локального и облачного интерфейса в один — [`docs/cloud-ui.md`](docs/cloud-ui.md).

---

## Local Runtime Manager

### Router mode (рекомендуется)

Один `llama-server`, запущенный без `-m` (`--models-preset` или `--models-dir`), обслуживает много моделей и грузит их по требованию — без перезапуска процесса и без убийства Pi-сессий. TaskBridge говорит на том же протоколе, что и встроенный в Pi провайдер `llama.cpp`: `/models`, `/models/load`, `/models/unload`, `/models/sse`.

```json
"localRuntime": {
  "provider": "llama.cpp",
  "healthUrl": "http://127.0.0.1:8080/health",
  "router": {
    "enabled": true,
    "command": "G:\\AIModels\\llamacpp\\llama-server.exe",
    "args": ["--host", "127.0.0.1", "--port", "8080", "--models-preset", "G:\\...\\models.ini", "--models-max", "1"],
    "cwd": "G:\\AIModels\\llamacpp"
  }
}
```

`models.ini` — пресеты llama.cpp (см. `models.example.ini`). Имя секции = id модели, который видит Pi (`llama.cpp/<section>`). У vision-пресета указывается `mmproj`, тогда llama.cpp отдаёт `architecture.input_modalities: ["text","image"]`, и Pi помечает модель как умеющую картинки — никаких ручных `input` в `models.json` больше не нужно.

Как это работает в UI/API:

- включённый router виден в шапке кнопкой «Локальные модели»: список моделей, `loaded/loading/unloaded`, бейдж `vision`, кнопки «Загрузить/Выгрузить/Отменить»;
- прогресс загрузки (включая mmproj) идёт из `/models/sse` и виден в оверлее и в событиях задачи (`LOCAL_MODEL_PROGRESS`);
- `POST /api/local/stop` останавливает router (только если процесс запустил сам TaskBridge);
- Pi подключается к router автоматически: TaskBridge прокидывает `LLAMA_BASE_URL` в окружение Pi (`pi.env`), без ручного `/login llama.cpp`; локальные модели попадают в общий селектор моделей вместе с облачными.

`--models-max` (по умолчанию 4) — опасно на одной GPU: ставьте `1`, иначе модели могут не помещаться в VRAM. `--sleep-idle-seconds` выгружает простаивающие модели. `--models-max`/`--models-autoload` — это флаги router, их нужно писать в `args`, а не в INI.

Перф-флаги в пресете не косметика. Без `device = CUDA0`, `split-mode = none`, `main-gpu = 0`, `load-mode = none`, `parallel = 1` и `cache-type-k/v = q4_0` на 16 ГБ 27B-Q4 уходит в RAM-спилл и prompt processing падает до нешаблонных ~20–130 tok/s. С ними на RTX 5070 Ti измерено **PP ≈ 1400 tok/s, TG ≈ 44 tok/s** (vision-пресет, ctx 33792).

### Legacy: single-model profiles

Если `localRuntime.router` не задан, работает прежняя схема: один процесс, профили `text`/`vision` в `localRuntime.profiles`, переключение через `/api/runtime/restart` (с перезапуском процесса и закрытием Pi-сессий).

```json
"localRuntime": {
  "healthUrl": "http://127.0.0.1:8080/health",
  "managed": { "enabled": true, "command": "...", "args": ["-m", "model.gguf", "-ngl", "all"] }
}
```

### Thinking level для router-моделей

Встроенный провайдер Pi `llama.cpp` отдаёт router-модели как `reasoning: false`,
поэтому Pi зажимает thinking level в `off` независимо от `--reasoning on` на
сервере. Чтобы thinking работал, в `~/.pi/agent/models.json` добавляется
провайдер-оверрайд `llama.cpp` (merge по `id`): для каждого пресета
`reasoning: true`, `thinkingLevelMap`, `compat.thinkingFormat = chat-template`
с `enable_thinking`/`reasoning_effort`, `contextWindow` и `input`
(`["text","image"]` для vision-пресетов). После этого
`get_available_thinking_levels` отдаёт `off/low/medium/xhigh`, а состояние
сессии показывает реальный уровень вместо `off`.

### Vision и вложения

Чтобы картинки дошли до модели, нужны два условия: (1) в Pi выключен `images.blockImages` в `~/.pi/agent/settings.json` — иначе Pi заменяет любую картинку на «Image reading is disabled.»; (2) у модели в Pi заявлен `input: ["text","image"]` — для router-моделей это приходит из llama.cpp автоматически. TaskBridge читает `settings.json` только для предупреждения: при `blockImages=true` `GET /api/info` возвращает `warnings` с кодом `PI_IMAGES_BLOCKED` и баннер в UI.

### AUTO dispatcher

При `localRuntime.auto.enabled = true` модель выбирается на задачу:

- во вложениях есть изображения и задан `auto.visionProfile` → vision-модель;
- иначе `auto.textProfile` / `defaultProfile`.

В router-режиме значениями `auto.*` служат id пресетов (без `profiles`). Выбор и причина сохраняются в `task.engine`.

### Engine health

`GET /api/info` возвращает `engine` (для single-model: `reachable`, `model`, `contextWindow`, `slots` из `/props` и `/slots`) и `local` (router: `state`, `loaded`, `models`). Ошибки провайдера классифицируются в стабильные коды: `QUOTA_EXCEEDED`, `RATE_LIMITED`, `CONTEXT_OVERFLOW`, `ENGINE_AUTH`, `MODEL_UNAVAILABLE`, `ENGINE_OVERLOADED`, `ENGINE_UNREACHABLE`; у задачи появляются `retryable` и `retryAfterMs`.

---

## MCP (pi-mcp-adapter)

TaskBridge не правит `~/.pi/agent/mcp.json`. Вместо этого у него свой файл
(`data/mcp.json`) и режим `pi.mcp.mode`:

- `inherit` — задачи используют MCP-конфиг Pi как есть (по умолчанию);
- `managed` — задачи запускаются с `--mcp-config data/mcp.json` и
  `PI_MCP_CONFIG_MODE=exclusive`, то есть используется **только** список
  TaskBridge. В UI («MCP» в шапке) серверы включаются/выключаются, есть
  «Импорт из Pi»;
- `off` — Pi запускается с пустым конфигом, MCP-инструментов у задачи нет.

Зачем: MCP-инструменты могут подменять работу модели. Например
`image-description-engine` умеет описывать картинки, и модель может «смотреть»
глазами MCP, а не своим vision. Отключив этот сервер в `managed`, получаем
честное зрение модели (проверено: задача вызывает только встроенный `read`).

В теле `POST /api/tasks` поддерживается `mcp: { disabledServers: ["..."] }` —
задача отключает конкретные серверы, не меняя общий список.

В диалоге «MCP» у каждого сервера раскрывается список инструментов с чекбоксами
(имена берутся из `~/.pi/agent/mcp-cache.json`); выключение пишет `excludeTools`
в `data/mcp.json`. Так можно отключить один инструмент, а не весь сервер.

---

## Cloud bridge (Vercel Queues)

Опциональный каталог `cloud/` разворачивается на Vercel отдельно от локального
сервера. Команды приходят на ПК через poll mode Vercel Queues, а события уходят
через дисковый outbox с batching, `taskId + seq` и idempotency keys. Локальный
SQLite остаётся source of truth; PostgreSQL, Redis и WebSocket для MVP не нужны.

Cloud по умолчанию выключен и не меняет LAN-режим. Полная инструкция по
environment variables, Vercel Root Directory и проверке: [docs/cloud-bridge.md](docs/cloud-bridge.md).

## Безопасность

В PoC авторизация опциональна (`server.auth.enabled`). Без неё использовать только:

- в доверенной домашней LAN;
- Windows Firewall profile = Private;
- не пробрасывать порт 8787 в интернет;
- не включать UPnP/port-forwarding для этого порта.

Встроенные меры: CSP и security-заголовки, проверка Origin, pairing-код с rate limit, timing-safe сравнение, защита от traversal при выдаче файлов, запрет symlink/junction при обходе сессий.

TaskBridge не имеет endpoint вида `/shell`, но Pi сам является coding agent и имеет файловые/shell tools внутри выбранного workspace — доступ к TaskBridge фактически равен доступу к агенту.

---

## Тесты

```powershell
npm test            # 216 тестов (215 pass, 1 skip — живой Postgres)
npm run test:cloud  # только тесты облачного транспорта
npm run stress      # стресс/soak (масштабируется через TASKBRIDGE_STRESS_*)
npm run check       # синтаксическая проверка основных файлов + аудит секретов
```

Покрыты: RPC-цикл, история и события, восстановление после restart, импорт Pi-сессий, SQLite и миграция, multipart-парсер, git/worktree/apply, project browser, лимиты и traversal, auth, классификация ошибок движка, AUTO-диспетчер, UI-состояние чата, а также cloud: нормализация и snapshot'ы, durable-последовательности, буфер/coalescing/backpressure, outbox и retry, идемпотентность команд, approvals (политика, менеджер, маршрутизация и end-to-end через Pi-хук), ограничение вывода инструментов и загрузка полного лога, смена модели/reasoning, метрики, API настроек облака, облачный API на memory и SQLite, replay без пропусков и дублей, reconcile, `/debug/cloud` и end-to-end запуск задачи из облака с живым стримингом и STOP. Стресс-набор (`npm run stress`) масштабируется переменными `TASKBRIDGE_STRESS_EVENTS`, `TASKBRIDGE_STRESS_LOG_MB`, `TASKBRIDGE_STRESS_SECONDS`.

---

## Устойчивость процессов: шаг 5 (AgentHost)

ТЗ v3 (этап 9) ставит цель: **перезапуск UI/gateway не должен убивать агента
(Pi) и не должен помечать активные задачи `FAILED_RECOVERY`.** Ниже — что уже
сделано, какие были альтернативы и почему выбран этот путь.

### Проблема (что было)

TaskBridge долго был одним монолитом: один OS-процесс (`node src/server.mjs`)
владел и HTTP/SSE, и процессами Pi (spawn через `src/pi-rpc.mjs`), и облачным
коннектором, и router llama.cpp. При `SIGTERM`
процесса:

- активные задачи на следующем старте помечались `FAILED_RECOVERY` (Pi-процесс
  «gone»);
- Pi — прямые дети серверного процесса → осиротевали/их stdin захлопывался;
- cloud relay/worker переподнимались, но live-сессия агента терялась.

Вывод из анализа: **Pi физически не может пережить смерть родителя**, поэтому
для аварийной устойчивости нужен отдельный процесс-владелец агента.

### Что сделано сейчас (инкрементальный путь)

1. **CLI `taskbridge`** (`bin/taskbridge.mjs`, шаг 5a, коммит `e36be2c`):
   `open` (последняя сессия в браузере, с авто-стартом сервера), `status`,
   `doctor`, `start`, `stop`. Административный/клиентский интерфейс, не трогает
   живой сервер. Поле `bin` в `package.json`.
2. **Graceful shutdown агента (шаг 5b, P-0):** новый `TaskManager.close()` —
   останавливает приём новой работы (очередь), закрывает каждую живую
   Pi-сессию `close → closeStdin → (2500мс) killTree` (та же семантика, что в
   `RuntimeControl.closePi`) и останавливает router llama.cpp. Вызывается из
   `SIGINT/SIGTERM` сервера с жёстким таймаутом, чтобы Ctrl+C всегда завершался
   и не оставлял осиротевших Pi/llama.cpp. Покрыто тестами
   (`tests/manager.test.mjs`, graceful + принудительный kill).
3. **Дизайн полного разделения** задокументирован в
   `docs/agent-host-separation.md` — как следующий (не начатый пока) этап.

### Альтернативы, которые рассматривались

| Вариант | Суть | Точка отказа / цена | Итог |
| --- | --- | --- | --- |
| **Полный split** host ⇄ gateway | Pi/облако/router+lock в фоновом host; gateway — IPC-клиент (COMMAND/RESULT/EVENT) | Единственный способ пережить жёсткий kill; но десятки маршрутов → IPC, новая плоскость отказов, миграция живого v0.9.2 | Цель шага 5; большой, рискованный; разбит на фазы P-1…P-4 (см. дизайн-док) |
| **Только graceful shutdown** | Гасить Pi/роутер чисто на SIGTERM | Дешево, без новых процессов; закрывает «штатный рестарт» с оставлением задачи | Не переживает жёсткий/аварийный kill |
| Replay через IPC вместо чтения SQLite | gateway не трогает store | Чище по владению «один писатель», но история гоняется по IPC | Оставлено как вариант B в дизайне; стартуем с A (прямое чтение, WAL) |

### Почему выбран этот путь

1. **Правильность по цели.** Только разделение реально даёт устойчивость к
   аварийному рестарту слоя UI. Это зафиксировано в ТЗ (этап 9: «gateway
   становится клиентом host»).
2. **Меньше всего сейчас, ценность раньше.** Полный split достигает цели
   только к P-3. Graceful shutdown (P-0) уже сейчас убирает «рестарт оставляет
   осиротевший Pi/висящий llama.cpp» — при умеренных затратах и без новых
   процессов. Он же станет первым звеном в будущем host.
3. **Защита рабочего деплоя.** Живой v0.9.2 не перестраивается вслепую:
   legacy-путь не удаляется до полного зелёного P-4, каждая фаза — отдельный
   коммит с зелёным прогоном. Откат в любой момент = `node src/server.mjs`.
4. **Не переплачиваем до появления боли.** Если штатный рестарт — редкая и
   плановая операция, полный split платит большую цену за редкую выгоду;
   разделение вводится, когда оно становится реальной болью.

Следующий шаг за этим решением: продолжить фазами P-1…P-4 из
`docs/agent-host-separation.md` (перенос владения агентом в `src/host.mjs`,
IPC-контракт, устойчивость к рестарту gateway), либо остановиться на P-0, если
жёсткий kill не является требованием.

---

## Известные ограничения

1. После restart при следующем сообщении запускается новый Pi-процесс с тем же файлом сессии; если файла Pi нет, история восстанавливается из событий TaskBridge.
2. Оборванные active tasks помечаются `FAILED` с кодом `FAILED_RECOVERY`; их можно продолжить новым сообщением. На штатном `SIGTERM` (Ctrl+C, `taskbridge stop`) агент теперь завершается чисто (`TaskManager.close()`): Pi и router llama.cpp не осиротвают, приём новых задач остановлен.
3. Одновременно рассчитан на одну активную inference-задачу.
4. Apply меняет рабочее дерево без коммита; проверки source-репозитория можно снять через `force`.
5. Verification commands доверенные и читаются из локального `config.json`.
6. Один HTTP-запрос отдаёт не более `server.maxEventsPerRequest` событий (по умолчанию 20000); более старая история — через `?tail`/`?before`.
7. `data/tasks/<id>/events.jsonl` и `task.json` после миграции остаются на диске как резерв и больше не обновляются.
8. Claude Code и Codex как отдельные runner'ы пока не подключены.
9. Картинки в Markdown-ответах и предпросмотр входящих вложений поддержаны частично.
10. Cloud transport: WebSocket-фастпас не реализован (polling корректен и обязателен, SSE есть на локальном хосте облака); Postgres-адаптер для serverless есть, но не проверен на живом сервере (`TASKBRIDGE_TEST_DATABASE_URL=postgres://… npm run test:cloud`).
11. Подтверждения инструментов включаются опцией `approvals.enabled`; расширение передаётся Pi через `--extension` (не ставится глобально). Длительный soak-прогон (30+ минут) запускается вручную через `TASKBRIDGE_STRESS_SECONDS`.

---

## Roadmap

```text
1. ClaudeCodeRunner
2. CodexRunner
3. KMP Android client
4. WebSocket/SSE fast path для Vercel
5. AgentHost: перезапуск UI/gateway без убийства агента
   (шаг 5; дизайн: docs/agent-host-separation.md, фазы P-1…P-4)
```

Главное — сначала проверить Pi RPC, live events и STOP на реальной локальной модели.

---

## Лицензия

Пока не выбрана. До добавления лицензии права не передаются по умолчанию.
