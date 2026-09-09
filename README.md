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
- [Архитектура](#архитектура)
- [Структура проекта](#структура-проекта)
- [Требования](#требования)
- [Быстрый старт](#быстрый-старт)
- [Добавление проекта](#добавление-проекта)
- [Конфигурация](#конфигурация)
- [HTTP API](#http-api)
- [Данные и артефакты](#данные-и-артефакты)
- [Git worktree](#git-worktree)
- [STOP, follow-up, compact, Pi state](#stop-follow-up-compact-pi-state)
- [Файлы с телефона](#файлы-с-телефона)
- [Local Runtime Manager](#local-runtime-manager)
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
- импорт уже существующих Pi-сессий проекта как задач TaskBridge;
- постраничная (turn-aligned) загрузка истории длинных сессий.

### Интерфейс

- локальный веб-UI, адаптированный под телефон;
- PWA (`manifest.webmanifest`, standalone), без внешних библиотек и CDN;
- Markdown и код в ответах (vendored `marked` + `DOMPurify`);
- сворачиваемые секции, чтобы длинный чат не растягивал экран;
- скачивание вложений и файлов workspace;
- просмотр артефактов задачи.

### Инфраструктура

- файловое persistent-хранилище задач и событий;
- `git status`, `git diff`, `diff.patch`;
- изолированный `git worktree` на задачу;
- project-specific verification commands;
- проверка здоровья локального llama.cpp endpoint и managed-запуск профилей `text` / `vision`;
- опциональная авторизация по pairing-коду и self-signed HTTPS для LAN.

---

## Технологии

| Слой | Что используется |
| --- | --- |
| Runtime | Node.js 20+, ESM (`.mjs`), без сборки и транспиляции |
| Backend | стандартный `node:http`, `node:child_process`, `node:crypto`, `node:fs/promises` |
| Агент | Pi CLI в режиме `--mode rpc` (JSONL over stdio) |
| Транспорт UI | HTTP + SSE |
| Frontend | нативный HTML/CSS/JS, PWA, без фреймворков |
| Markdown | `marked` + `DOMPurify` (лежат в `web/vendor`, без CDN) |
| Тесты | встроенный `node:test` + `linkedom` для DOM-тестов |
| Хранилище | файлы JSON/JSONL на диске (SQLite пока нет) |

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
│  ├─ task-store.mjs        файловое хранилище задач и событий
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
│  └─ config.mjs            загрузка/сохранение config.json
├─ web/
│  ├─ index.html            разметка UI
│  ├─ app.js                логика UI, SSE, рендер чата
│  ├─ chat-state.mjs        чистое состояние чата (тестируемое)
│  ├─ app.css               стили
│  ├─ manifest.webmanifest  PWA-манифест
│  └─ vendor/               marked, DOMPurify и их лицензии
├─ tests/                   59 тестов на node:test
├─ scripts/
│  └─ pi-rpc-smoke.mjs      smoke-тест Pi RPC
├─ docs/                    ТЗ, ревью и планы
├─ config.example.json      шаблон конфигурации
├─ start.cmd                запуск на Windows
└─ data/                    задачи, события, worktree, логи (не в git)
```

---

## Требования

- Windows 10/11 (основная целевая платформа);
- Node.js 20+;
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
| `server.auth.enabled` | включить pairing-авторизацию |
| `server.https.enabled` / `port` | self-signed HTTPS для LAN |
| `pi.command` / `pi.args` | как запускать Pi |
| `pi.persistSessions` | сохранять файлы сессий Pi |
| `pi.projectTrust` | доверие проекту в Pi |
| `pi.abortTimeoutMs` | сколько ждать RPC `abort` до kill |
| `pi.sessionRoots` | дополнительные папки сессий Pi для импорта |
| `localRuntime.healthUrl` | health-check локальной модели |
| `localRuntime.profiles` | профили запуска (`text`, `vision`, …) |
| `localRuntime.managed` | управляемый запуск llama.cpp |
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
| `GET` | `/api/info` | имя, build, адреса, готовность модели, лимиты файлов |
| `GET` | `/api/projects` | список проектов |
| `DELETE` | `/api/projects/:id` | удалить проект |
| `GET` | `/api/project-browser` | список папок в разрешённых корнях |
| `POST` | `/api/project-browser/register` | зарегистрировать проект |
| `GET` | `/api/projects/:id/pi-sessions` | существующие Pi-сессии проекта |
| `GET` | `/api/tasks` | список сессий/задач |
| `POST` | `/api/tasks` | создать задачу |
| `POST` | `/api/tasks/from-session` | импортировать Pi-сессию как задачу |
| `GET` / `DELETE` / `PATCH` | `/api/tasks/:id` | получить / удалить / переименовать |
| `GET` | `/api/tasks/:id/events` | события (`after`, `limit`, `tail`, `before`) |
| `GET` | `/api/tasks/:id/stream` | SSE-поток live events |
| `GET` | `/api/tasks/:id/state` | состояние Pi |
| `POST` | `/api/tasks/:id/message` | follow-up / steering |
| `POST` | `/api/tasks/:id/cancel` | STOP |
| `POST` | `/api/tasks/:id/compact` | COMPACT |
| `POST` | `/api/tasks/:id/auto-compaction` | вкл/выкл auto compaction |
| `GET` | `/api/tasks/:id/artifacts` | список артефактов |
| `GET` | `/api/tasks/:id/artifacts/:name` | скачать артефакт |
| `GET` | `/api/tasks/:id/files/:id` | скачать вложение |
| `GET` | `/api/tasks/:id/workspace-file?path=` | файл из workspace |
| `GET` | `/api/runtime` | статус локальной модели |
| `POST` | `/api/runtime/start` / `restart` | запустить/перезапустить профиль |

---

## Данные и артефакты

```text
data/
├─ tasks/<task-id>/
│  ├─ task.json
│  ├─ events.jsonl
│  ├─ files/                вложения
│  └─ artifacts/
│     ├─ result.md
│     ├─ result.json
│     ├─ diff.patch
│     ├─ git-status.txt
│     ├─ pi-events.jsonl
│     ├─ pi.stderr.log      (если был stderr)
│     ├─ verification.log   (если настроена verification)
│     └─ runtime.log        (если TaskBridge запускал runtime)
├─ worktrees/<task-id>/     изолированный checkout
├─ pi-sessions/             сессии Pi
├─ server-auth.json         секрет pairing (если auth включён)
└─ tls/                     self-signed сертификаты
```

Вложения, отправленные с телефона, попадают в `.taskbridge-input/` внутри workspace, а к prompt добавляется список путей.

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

---

## Файлы с телефона

В PoC upload идёт как base64 внутри JSON, поэтому предназначен для небольших файлов; для больших ZIP/проектов механизм не подходит. Лимит тела:

```json
"server": { "maxBodyMb": 25 }
```

Base64 добавляет ~33% объёма, поэтому реальный предел вложений меньше заявленного. Production-версия должна перейти на streaming multipart upload.

---

## Local Runtime Manager

По умолчанию проверяется `http://127.0.0.1:8080/health`. Если сервер уже работает — статус `EXTERNAL_RUNNING`, и TaskBridge его не останавливает.

Управляемый запуск:

```json
"localRuntime": {
  "healthUrl": "http://127.0.0.1:8080/health",
  "managed": {
    "enabled": true,
    "command": "G:\\AIModels\\llamacpp\\llama-server.exe",
    "args": ["-m", "G:\\AIModels\\model.gguf", "--host", "127.0.0.1", "--port", "8080", "-ngl", "all"],
    "cwd": "G:\\AIModels\\llamacpp"
  }
}
```

Для первой проверки лучше оставить свой llama-server уже запущенным. Профили `text` / `vision` задаются в `localRuntime.profiles` и переключаются из UI.

---

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
npm test          # 59 тестов на node:test
npm run check     # синтаксическая проверка основных файлов
```

Покрыты: RPC-цикл, история и события, восстановление после restart, импорт Pi-сессий, git/worktree, project browser, лимиты и traversal, auth, UI-состояние чата.

---

## Известные ограничения

1. Task store файловый, не SQLite.
2. После restart при следующем сообщении запускается новый Pi-процесс с тем же файлом сессии; если файла Pi нет, история восстанавливается из событий TaskBridge.
3. Оборванные active tasks помечаются `FAILED` с кодом `FAILED_RECOVERY`; их можно продолжить новым сообщением.
4. Одновременно рассчитан на одну активную inference-задачу.
5. Upload предназначен для небольших файлов (base64 в JSON).
6. Нет автоматической очистки worktree.
7. `diff.patch` не содержит содержимое новых untracked файлов; они перечисляются в `git-status.txt`.
8. Verification commands доверенные и читаются из локального `config.json`.
9. Claude Code и Codex как отдельные runner'ы пока не подключены.
10. Картинки в Markdown-ответах и предпросмотр входящих вложений поддержаны частично.

---

## Roadmap

```text
1. SQLite вместо файлового store
2. multipart streaming upload
3. worktree cleanup / apply
4. ClaudeCodeRunner
5. CodexRunner
6. engine health / quota mapping
7. AUTO dispatcher
8. KMP Android client
```

Главное — сначала проверить Pi RPC, live events и STOP на реальной локальной модели.

---

## Лицензия

Пока не выбрана. До добавления лицензии права не передаются по умолчанию.
