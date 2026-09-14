# TaskBridge

**Пульт управления локальным coding-агентом Pi с телефона по Wi‑Fi.**

TaskBridge (v0.9.5) — небольшой локальный HTTP/PWA-сервер, который запускается на компьютере рядом с проектом и даёт с телефона:

- поставить задачу выбранной модели в выбранном проекте;
- видеть в реальном времени, что делает агент (tools, streaming, статусы);
- остановить выполнение кнопкой `STOP`;
- дописать/уточнить задачу в живую сессию (follow-up / steering);
- править, ветвить, удалять и перегенерировать отдельные сообщения и ходы;
- видеть, почему машина думает долго: скорости модели (PP/TG) и загрузку GPU/CPU/RAM;
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

Основной режим сейчас — **local-only по Wi‑Fi**: облачный транспорт (удалённый доступ через интернет) реализован на серверной стороне, но выключен (`cloud.enabled: false`), а вход в облачные настройки убран из интерфейса — см. [Cloud transport](#cloud-transport-remote-access). Облако **не входит в релиз 1.0** — см. [Roadmap](#roadmap).

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
- как в современных чатах: `Enter` — поставить в очередь (даже если модель свободна: сессия подхватит сразу), `Ctrl+Enter` (Cmd+Enter) — отправить немедленно, не дожидаясь модели; сообщения в очереди видны над полем ввода (с количеством) и у каждого есть «Отправить сейчас» и «Убрать»; несколько сообщений к одной сессии ждут своей очереди по порядку и не теряются;
- действия на каждом сообщении завершённой сессии (встроенным SVG, без эмодзи): **править** сообщение оператора («исправить и запустить заново»), **ветвить** разговор от любого хода, **удалить** ход, **перегенерировать** ответ. Под этим — `POST /api/tasks/:id/turns/:turnId/edit`, `…/delete`, `…/regenerate`, `…/fork`; правка сохраняет тот же seq, а обрезание хвоста помечается `TURN_EDITED` / `TURN_TRUNCATED`, поэтому живой клиент видит ровно то же, что и БД;
- восстановление неудавшегося последнего хода: если модель уже успела выдать текст или вызвать инструмент, «⧉ Скопировать сообщение» возвращает вывод в поле ввода (откатить ход нельзя — вывод был бы потерян); если модель ничего не произвела, ход повторяют через «изменить и отправить заново» или «перегенерировать»;
- пока задача выполняется, ход править/ветвить нельзя: панель действий скрыта, история живой сессии не меняется.

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
- скорости загруженной модели (PP/TG) и состояние ПК — CPU (дельтами `os.cpus()`), RAM и GPU через `nvidia-smi` — в `GET /api/info` (`engine.metrics`, `system`);
- `GET /api/metrics` — счётчики задач/событий/облака, в том числе в формате Prometheus;
- web-push уведомления (VAPID): `GET /api/push/key`, `POST /api/push/subscribe` / `unsubscribe` / `test`;
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
| Тесты | встроенный `node:test` + `linkedom` для DOM-тестов (54 файла) |
| Хранилище | SQLite через встроенный `node:sqlite` (`data/taskbridge.db`, WAL) |
| Наблюдаемость | `/api/metrics` (+ Prometheus), PP/TG из `/metrics` llama.cpp, GPU через `nvidia-smi` |
| Облако (опция) | `cloud/` — Vercel-совместимый control plane: роутер, store (memory/sqlite/postgres), relay, WS; локально `npm run cloud` |

---

## Архитектура

```text
┌──────────────┐   HTTP / SSE    ┌──────────────────────────────────────┐
│  Телефон     │ ───────────────▶│  TaskBridge (Node.js, node:http)     │
│  браузер/PWA │◀─────────────── │                                      │
                                 │  server.mjs  (loopback) / proxy.mjs │
                                 │  task-manager/session-manager  цикл  │
                                 │  pi-rpc.mjs / runners/pi-runner      │
                                 │  task-store.mjs  события/метаданные  │
                                 │  events/, domain/  TaskEvent, seq    │
                                 │  git.mjs         worktree, diff      │
                                 │  local-models    llama.cpp router    │
                                 │  system-metrics/metrics  PP/TG, ж.   │
                                 │  cloud/worker    outbox, relay (off) │
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
│  ├─ api-contract.mjs      опубликованный контракт API: версия + список маршрутов
│  ├─ proxy.mjs             LAN-турникет варианта B: LAN-вход в приложение на loopback (TLS, Host)
│  ├─ task-manager.mjs      жизненный цикл задач, очередь, сообщения, Pi-сессии
│  ├─ session-manager.mjs   владение Pi-сессиями: Run, idle, close
│  ├─ runners/pi-runner.mjs запуск/остановка процесса Pi на задачу
│  ├─ pi-rpc.mjs            JSONL RPC-клиент Pi
│  ├─ task-store.mjs        SQLite-хранилище задач и событий
│  ├─ instance-lock.mjs     один экземпляр на data-каталог (pid-lock)
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
│  ├─ text-tail.mjs         ограниченный хвост текста (streaming)
│  ├─ tool-output.mjs       rolling-окно вывода инструментов
│  ├─ git.mjs               worktree, status, diff, patch
│  ├─ files.mjs             вложения, лимиты, безопасные пути
│  ├─ metrics.mjs           /api/metrics (в т.ч. Prometheus)
│  ├─ system-metrics.mjs    CPU/RAM/GPU и PP/TG модели
│  ├─ runtime-manager.mjs   health-check и запуск llama.cpp
│  ├─ runtime-control.mjs   профили runtime, start/restart/status
│  ├─ project-browser.mjs   браузер папок для регистрации проектов
│  ├─ auth.mjs              pairing-код, cookie, rate limit
│  ├─ tls.mjs               self-signed сертификат для LAN HTTPS
│  ├─ config.mjs            загрузка/сохранение config.json
│  ├─ approvals/policy.mjs  политика подтверждений опасных tool-вызовов
│  ├─ push/                 web-push (VAPID) и центр уведомлений
│  ├─ domain/               протокол: TaskEvent, CloudCommand, machine state
│  ├─ events/               EventMux, sequence, нормализация, snapshot'ы
│  └─ cloud/                CloudWorker, outbox, heartbeat, dispatcher, approvals
├─ pi-extension/            Pi-расширение: подтверждение опасных tool-вызовов
├─ cloud/                   облачный control plane (Vercel-совместимый)
│  ├─ lib/                  роутер API, auth, credentials, store (memory/sqlite/postgres), relay/ws, errors, ids
│  ├─ api/index.mjs         Vercel function (общий роутер)
│  └─ server.mjs            локальный хост облака + SSE (раздаёт тот же web/)
├─ api/index.mjs            Vercel-энтрипоинт (реэкспорт cloud/api)
├─ .vercelignore            исключает config.json/data из CLI-деплоя
├─ vercel.json              конфиг Vercel (outputDirectory: web — один UI)
├─ web/
│  ├─ index.html            разметка UI
│  ├─ app.js                логика UI, SSE, рендер чата
│  ├─ chat-state.mjs        чистое состояние чата (тестируемое)
│  ├─ transport.mjs         выбор local/cloud транспорта для UI
│  ├─ cloud-config.js       /cloud-config.js (настройки облака для страницы)
│  ├─ sw.js                 service worker PWA
│  ├─ app.css               стили
│  ├─ manifest.webmanifest  PWA-манифест
│  └─ vendor/               marked, DOMPurify и их лицензии
├─ tests/                   54 файла тестов на node:test (~398 проверок)
├─ scripts/
│  ├─ pi-rpc-smoke.mjs      smoke-тест Pi RPC
│  ├─ cloud-secrets.mjs     генерация токенов/секретов (npm run cloud:secrets)
│  ├─ cloud-deploy.mjs      автодеплой на Vercel (npm run cloud:deploy)
│  ├─ cloud-local.mjs       локальный прогон облака (start/status/stop/verify)
│  ├─ check-secrets.mjs     аудит утечек (npm run check:secrets)
│  ├─ restart-and-verify.mjs перезапуск и проверка сервера
│  ├─ start-lan.mjs         запуск варианта B (npm run lan:start/status/stop)
│  ├─ lan-acceptance.mjs    приёмка шага 5: турникет переживает рестарт агента
│  └─ backup.mjs            снимок БД (npm run backup)
├─ docs/                    ТЗ, ревью и планы
├─ config.example.json      шаблон конфигурации
├─ models.example.ini       шаблон пресетов llama.cpp router (скопируйте в models.ini)
├─ start.cmd                запуск на Windows (LAN-режим: приложение + турникет)
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
start.cmd        # или: npm start
```

Запускается **LAN-режим**: приложение поднимается только на `127.0.0.1`,
а в сеть смотрит турникет (`src/proxy.mjs`) — тогда перезапуск сетевой части не
убивает агента (см. [Устойчивость процессов](#устойчивость-процессов-шаг-5-lan-турникет)).
При первом старте автоматически создаётся `config.json` из `config.example.json`. В выводе видно оба процесса и адрес для телефона:

```text
TaskBridge MVP listening on 127.0.0.1:51234
LAN (Ethernet 2): http://192.168.1.42:8787

[lan] app 4242 on 127.0.0.1:51234 (loopback only)
[lan] proxy 4243 on 0.0.0.0:8787 — this is what the phone opens
[lan] http://127.0.0.1:8787 · Ctrl+C stops both
```

На телефоне в той же Wi‑Fi сети открыть LAN URL (порт из `config.json`).
Остановить — `Ctrl+C` в этом окне, или `taskbridge stop` / `npm run lan:stop`.
Фоновый запуск — `npm run lan:start`.

Один процесс (старое поведение) остаётся доступен как аварийный вариант:
`npm run start:monolith` или `taskbridge start --monolith`.

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

Машиночитаемый контракт — [`src/api-contract.mjs`](src/api-contract.mjs) (версия
`apiVersion` в `GET /api/info`), описание для клиента —
[`docs/api-contract.md`](docs/api-contract.md); расхождение ловит
`tests/api-contract.test.mjs`.

Все `/api/*`, кроме `auth`/`health`, требуют авторизацию, если она включена.

| Метод | Путь | Назначение |
| --- | --- | --- |
| `GET` | `/api/health` | liveness |
| `GET` | `/api/auth` | статус авторизации |
| `POST` | `/api/auth/pair` | вход по pairing-коду |
| `GET` | `/api/auth/pairing` | текущий код (только с localhost) |
| `GET` | `/api/info` | имя, build, адреса, готовность модели, engine health, скорости модели (`engine.metrics`), состояние ПК (`system`), лимиты файлов |
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
| `POST` | `/api/tasks/:id/undo-last-turn` | откатить последний чистый ход (API; в UI заменён копированием текста) |
| `POST` | `/api/tasks/:id/turns/:turnId/edit` | исправить сообщение оператора и перезапустить ход (`TURN_EDITED`) |
| `POST` | `/api/tasks/:id/turns/:turnId/delete` | удалить ход и всё после него (`TURN_TRUNCATED`) |
| `POST` | `/api/tasks/:id/regenerate` | удалить ответ и запросить его заново (вопрос тот же) |
| `POST` | `/api/tasks/:id/fork` | ветка: новая сессия из разговора до выбранного хода |
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
| `GET` | `/api/metrics` | метрики в JSON или Prometheus (`?format=prometheus`) |
| `GET` / `POST` | `/api/push/key` · `/api/push/subscribe` · `/api/push/unsubscribe` · `/api/push/test` | web-push (VAPID): ключ, подписка, отписка, тест |
| `POST` | `/api/commands/:commandId` | приём команды облака (идемпотентно) |
| `GET` / `POST` | `/api/cloud/config` · `/api/cloud/test` · `/api/cloud/pair` · `/api/cloud/devices` | настройка, проверка, паринг и устройства облака (серверные) |
| `GET` | `/debug/cloud` | диагностика облачного транспорта |

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

> **Статус:** серверная часть готова и покрыта тестами, но транспорт сейчас
> **выключен** (`cloud.enabled: false`), а вход в облачные настройки (иконка ☁ и
> диалог) убран из UI — работаем только по локальной сети. Экран и включение
> возвращаются откатом коммита `96792db`. В релиз **1.0 облако не входит**
> (см. [Roadmap](#roadmap)).

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
redaction секретов и путей, метрики (`/api/metrics`, в т.ч. Prometheus),
диагностика `/debug/cloud` (экран настроек облака убран из UI вместе с
выключением транспорта, серверные `/api/cloud/*` работают как прежде).

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

Полная документация, API и список известных пробелов — в
[`docs/cloud-transport.md`](docs/cloud-transport.md).
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

### Скорости модели и состояние ПК

Пока модель отвечает, из `GET /api/info` видно, тормозит ли она (и почему):

- `engine.metrics` — скорости загруженной llama.cpp-модели. PP (prompt) и TG
  (generation) в tok/s берутся из `/metrics` сервера, который роутер
  проксирует в дочерний процесс (`llamacpp:prompt_tokens_seconds`,
  `llamacpp:predicted_tokens_seconds`). **Нужен `metrics = true` в пресете
  (`[*]` в `models.ini`)** и перезапуск роутера. Без него `/metrics` отвечает
  501, и UI честно показывает «нет данных», а не ноль.
- TG облачной модели — из её же `usage`: output-токены за время, что приходили
  дельты (`task.metrics`, поле `tg`). Паузы между дельтами > 2 с (выполнение
  инструментов) в генерацию не считаются. Показывается в строке Context.
- `system` — CPU (из дельт `os.cpus()`; `os.loadavg()` на Windows всегда нули),
  RAM (used/total) и, если есть `nvidia-smi`, GPU: память, утилизация,
  мощность draw/limit, температура. Нет данных — поле `null`, а не ноль.

В UI это кликабельная плашка «Состояние системы» в шапке: компактная сводка
(GPU/CPU/RAM), а по клику — все параметры и скорости модели. Обновляется тем же
опросом `/api/info` раз в 4 с.

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
сервера. Команды приходят на ПК через очередь облака (poll) и WebSocket-релай
(`cloud/lib/relay*.mjs`, `cloud/lib/ws.mjs` — RFC 6455 без зависимостей), а события
уходят через дисковый outbox с batching, `taskId + seq` и idempotency keys.
Локальный SQLite остаётся source of truth; хранилище облака — memory / sqlite /
postgres (`cloud/lib/store-postgres.mjs`).

Cloud по умолчанию выключен и не меняет LAN-режим. Локальный прогон облака —
`npm run cloud:local` (`start` / `status` / `stop` / `verify`). Полная инструкция по
environment variables, Vercel Root Directory и проверке —
[docs/cloud-transport.md](docs/cloud-transport.md) и
[docs/cloud-deploy-vercel.md](docs/cloud-deploy-vercel.md).

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
npm test            # 398 тестов в 54 файлах (396 pass, 2 skip: живой Postgres и облачный DOM-тест)
npm run test:cloud  # только тесты облачного транспорта
npm run stress      # стресс/soak (масштабируется через TASKBRIDGE_STRESS_*)
npm run check       # синтаксическая проверка основных файлов + аудит секретов
```

Покрыты: RPC-цикл, история и события, восстановление после restart, импорт Pi-сессий, SQLite и миграция, multipart-парсер, git/worktree/apply, project browser, лимиты и traversal, auth, классификация ошибок движка, AUTO-диспетчер, UI-состояние чата, а также cloud: нормализация и snapshot'ы, durable-последовательности, буфер/coalescing/backpressure, outbox и retry, идемпотентность команд, approvals (политика, менеджер, маршрутизация и end-to-end через Pi-хук), ограничение вывода инструментов и загрузка полного лога, смена модели/reasoning, метрики, API настроек облака, облачный API на memory и SQLite, replay без пропусков и дублей, reconcile, `/debug/cloud` и end-to-end запуск задачи из облака с живым стримингом и STOP. Стресс-набор (`npm run stress`) масштабируется переменными `TASKBRIDGE_STRESS_EVENTS`, `TASKBRIDGE_STRESS_LOG_MB`, `TASKBRIDGE_STRESS_SECONDS`.

---

## Устойчивость процессов: шаг 5 (LAN-турникет)

ТЗ v3 (этап 9) ставит цель: **перезапуск UI-слоя не должен убивать агента (Pi)
и не должен помечать активные задачи `FAILED_RECOVERY`.**

### Проблема (что было)

TaskBridge долго был одним монолитом: один OS-процесс (`node src/server.mjs`)
владел и HTTP/SSE, и процессами Pi, и облачным коннектором, и router llama.cpp.
Рестарт этого процесса убивал живую сессию: активные задачи на следующем старте
помечались `FAILED_RECOVERY`, а Pi осиротевали.

### Как сделано

1. **CLI `taskbridge`** (`bin/taskbridge.mjs`): `open` (последняя сессия в браузере,
   с авто-стартом сервера), `status`, `doctor`, `start`, `stop`.
2. **Graceful shutdown агента.** `TaskManager.close()` останавливает приём новой
   работы, закрывает каждую живую Pi-сессию (`close → closeStdin → (2500 мс)
   killTree`) и останавливает router llama.cpp; вызывается из `SIGINT/SIGTERM` с
   жёстким таймаутом, чтобы Ctrl+C всегда завершался и не оставлял осиротевших
   Pi/llama.cpp. Покрыто `tests/manager.test.mjs`.
3. **LAN-турникет — текущий дизайн (вариант B).** Приложение (`src/server.mjs`)
   остаётся единственной реализацией API, но слушает только `127.0.0.1`; в LAN
   смотрит `src/proxy.mjs`, который ничего не знает про TaskBridge и просто
   передаёт запросы и ответы. Запуск — `npm run lan:start`, состояние и остановка —
   `npm run lan:status` / `lan:stop` (дефолт `npm start` пока не менялся).
   Паритет гарантирован **по построению**, а не по числу портированных маршрутов:
   `tests/lan-mode.test.mjs` прогоняет через турникет весь опубликованный контракт.
   Гарантию шага 5 проверяет процессная приёмка `npm run lan:acceptance`: убить
   турникет → агент жив и держит сессию; новый турникет → история цела и живой
   поток открывается.

### Что рассматривалось и отвергнуто

Был реализован полный split `host ⇄ gateway` (P-1…P-3): отдельный процесс-владелец
агента плюс HTTP/SSE-фронт, говорившие по IPC (`HELLO/COMMAND/RESULT/EVENT`).
От него отказались по цене: фронт отвечал **6 группам маршрутов из ~40**, и каждый
маршрут пришлось бы описывать дважды — в IPC-команде и в самом фронте. Две таблицы
расходятся, а расходящееся описание API ломает и «стабильное ядро», и «безупречный
UI/UX». Код split'а удалён; разбор решения и остаток — в
[`docs/agent-host-separation.md`](docs/agent-host-separation.md) §12/§12.1.

Вариант «только graceful shutdown» остаётся частью решения (пункт 2), но сам по
себе цель не закрывает: он не переживает аварийный kill (это отдельный критерий
K2 в роадмапе).

Дефолт переведён: `npm start`, `start.cmd` и `taskbridge start` поднимают именно
LAN-режим (турникет + приложение на loopback); `taskbridge stop` и
`npm run lan:stop` останавливают оба процесса. Остался один хвост —
`scripts/restart-and-verify.mjs` пока перезапускает приложение целиком, а не
только турникет (§12.1).


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
10. Cloud transport сейчас выключен (`cloud.enabled: false`) и убран из UI — рабочий режим local-only по Wi‑Fi. В серверной части есть WebSocket-релай (`cloud/lib/ws.mjs` + `relay-server.mjs`, машина через `src/cloud/relay-connector.mjs`) как realtime-канал, а poll-путь остаётся обязательным фолбэком; Postgres-адаптер для serverless написан, но на живом сервере не прогонялся (`TASKBRIDGE_TEST_DATABASE_URL=postgres://… npm run test:postgres`), и на живую Vercel деплой ещë не выполнялся.
11. Подтверждения инструментов включаются опцией `approvals.enabled`; расширение передаётся Pi через `--extension` (не ставится глобально). Длительный soak-прогон (30+ минут) запускается вручную через `TASKBRIDGE_STRESS_SECONDS`.

---

## Roadmap

Ближайшая цель — **1.0: стабильное ядро и безупречный UI/UX**.
Облако в первую версию намеренно **не входит**: транспорт остаётся выключенным
(`cloud.enabled: false`), его работа вынесена за релиз.

### Критерии 1.0

**Стабильное ядро**

- AgentHost / P-4: дефолт — «приложение на loopback + турникет»
  (§12.1, шаги 5–6 сделаны: `npm start`, `start.cmd`, `taskbridge` про два
  процесса; осталась только `restart-and-verify`);
- аварийный рестарт больше не оставляет задачи в `FAILED_RECOVERY`;
- долгий soak без потерь: очередь, восстановление сессии, повтор упавшего хода,
  нет осиротевших Pi/llama.cpp;
- HTTP API и контракт `TaskEvent` объявлены стабильными;
- закрыты пункты «Известные ограничения» (одна активная inference-задача,
  `FAILED_RECOVERY`, частичные картинки и т.д.);
- выбрана лицензия.

**Безупречный UI/UX**

- ни одного «сырого» статуса и висящего оверлея; состояние модели/системы честное
  («нет данных», а не ноль);
- мобильный чат предсказуем: действия сообщений (править/ветка/удалить/заново),
  очередь, вложения и ошибки — без потери набранного текста;
- регресс-покрытие: DOM-тесты на ключевые сценарии + ручной чек-лист
  ([TEST_PLAN.md](TEST_PLAN.md)).

### После 1.0

```text
1. Cloud transport: живой деплой (Vercel + Postgres), проверка relay/WS,
   возврат входа в облачные настройки в UI
2. ClaudeCodeRunner
3. CodexRunner
4. KMP Android client
```

Главное — сначала проверить Pi RPC, live events и STOP на реальной локальной модели.

---

## Лицензия

MIT — см. [LICENSE](LICENSE). Правообладатель: `Arnyigor`.

До этого лицензия не была выбрана, то есть права по умолчанию не передавались.
