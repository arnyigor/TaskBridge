# TaskBridge / AgentBridge — обновлённое техническое задание

**Версия:** 2.0  
**Статус:** актуальная архитектура после выбора Pi как основного coding-agent runtime  
**Целевая платформа сервера:** Windows 10/11  
**Основной способ доступа:** локальная Wi‑Fi сеть  
**MVP-клиент:** PWA  
**Будущий клиент:** KMP Android  
**Основной локальный агент:** Pi + локальная модель через llama.cpp  
**Дополнительные исполнители:** Claude Code, Codex  
**OpenClaw:** не входит в основной execution path

---

# 1. Назначение системы

TaskBridge — лёгкий локальный control plane для удалённого запуска и контроля AI coding agents с телефона.

Основной сценарий:

```text
Телефон
  ↓ Wi‑Fi
PWA / позже KMP
  ↓
TaskBridge
  ↓
выбор проекта / workspace
  ↓
Pi
  ↓
локальная Qwen через llama.cpp
  ↓
изменения проекта
  ↓
verification
  ↓
логи / diff / результат
  ↓
телефон
```

Дополнительный сценарий:

```text
TaskBridge
   ├─ Pi + Local LLM
   ├─ Claude Code
   └─ Codex
```

Пользователь должен иметь возможность:

- отправить текстовую задачу;
- приложить файлы;
- выбрать зарегистрированный проект;
- выбрать исполнителя;
- запустить задачу;
- закрыть браузер;
- видеть live-прогресс Pi с телефона;
- видеть tool events и состояние контекста;
- отменить выполнение;
- отправить follow-up;
- вручную инициировать compaction;
- получить diff, результаты тестов и итоговый отчёт.

---

# 2. Главная архитектурная граница

TaskBridge **не является AI-agent framework**.

Pi отвечает за:

```text
agent loop
LLM conversation
tool calling
coding-agent behaviour
session
context
compaction
model interaction
```

TaskBridge отвечает за:

```text
LAN API
mobile UI
task persistence
project registry
file upload
workspace preparation
Git worktree
process lifecycle
runtime lifecycle
live events
cancel
verification
result
history
Claude/Codex direct adapters
```

Это принципиальное разделение.

Не нужно повторно реализовывать внутри TaskBridge:

- собственный LLM tool loop;
- собственный conversation engine;
- собственный coding harness;
- собственный compaction algorithm;
- собственную provider abstraction;
- собственный формат Pi sessions.

---

# 3. OpenClaw

OpenClaw не используется в основном пути:

```text
Phone → OpenClaw → Pi
```

Основной путь:

```text
Phone → TaskBridge → Pi
```

OpenClaw при желании может остаться отдельным инструментом для:

- cron;
- automation;
- каналов;
- нерегулярных assistant workflow.

TaskBridge не должен зависеть от OpenClaw для выполнения coding-задач.

---

# 4. Целевая архитектура

```text
┌─────────────────────────────────────┐
│             Android / PWA           │
│                                     │
│ task / files / project / executor   │
└─────────────────┬───────────────────┘
                  │ HTTP + SSE/WS
                  │ LAN / Wi‑Fi
                  ▼
┌───────────────────────────────────────────────────────────┐
│                      TASKBRIDGE                           │
│                                                           │
│  API                                                      │
│   │                                                       │
│  Task Manager                                             │
│   │                                                       │
│  Persistent Queue                                         │
│   │                                                       │
│  Task Worker                                              │
│   ├─ Project Registry                                     │
│   ├─ Workspace Manager                                    │
│   ├─ Git Worktree Manager                                 │
│   ├─ Agent Manager                                        │
│   │    ├─ PiAgentRunner                                   │
│   │    ├─ ClaudeCodeRunner                                │
│   │    └─ CodexRunner                                     │
│   ├─ Local Runtime Manager                                │
│   ├─ Event Bus                                            │
│   ├─ Verification Runner                                  │
│   └─ Result Builder                                       │
│                                                           │
└───────────────┬───────────────────────┬───────────────────┘
                │                       │
                ▼                       ▼
              Pi                     Direct CLI
                │                    Claude/Codex
                ▼
          llama.cpp :8080
                │
                ▼
            Local Qwen
```

---

# 5. Рекомендуемый стек

После выбора Pi центральным runtime рекомендуется:

## Backend

- Node.js
- TypeScript
- Fastify
- SQLite
- WebSocket или SSE
- Pi SDK, если доступен и стабилен для выбранной установки
- Pi RPC как альтернативный/изолированный transport
- стандартный Node child_process для Claude/Codex/runtime processes

## Frontend MVP

- HTML
- CSS
- TypeScript/JavaScript
- без React/Vue
- PWA Manifest
- Fetch
- SSE или WebSocket

## Почему TypeScript

Pi становится ключевой частью backend, поэтому прямое взаимодействие с его SDK уменьшает количество промежуточных слоёв.

При этом TaskBridge должен использовать внутренний интерфейс `AgentRunner`, чтобы Pi можно было заменить или запускать через RPC без переписывания ядра.

---

# 6. Абстракция агента

```ts
interface AgentRunner {
  preflight(ctx: RunContext): Promise<PreflightResult>;
  start(ctx: RunContext): Promise<AgentRun>;
  sendMessage(runId: string, text: string): Promise<void>;
  compact(runId: string, instructions?: string): Promise<CompactionResult>;
  cancel(runId: string): Promise<void>;
  getState(runId: string): Promise<AgentState>;
}
```

Реализации:

```text
PiAgentRunner
ClaudeCodeRunner
CodexRunner
```

Для Claude/Codex методы `sendMessage`/`compact` могут быть `UNSUPPORTED`, если конкретный runtime этого не предоставляет.

---

# 7. Режимы исполнителя

Начальные:

```text
PI_LOCAL
CLAUDE
CODEX
```

После MVP:

```text
AUTO
LOCAL_FIRST
CLAUDE_FIRST
CODEX_FIRST
QUALITY_FIRST
LOCAL_ONLY
```

В MVP `AUTO` отсутствует.

---

# 8. Почему Dispatcher LLM не входит в MVP

В MVP пользователь сам выбирает исполнителя:

```text
Project: AndroidMrPlanner
Executor: Pi / Local
Task: Исправь failing tests
```

TaskBridge не должен «угадывать», что требуется.

Dispatcher LLM появляется только после того, как:

- Pi стабильно запускается;
- logs/events работают;
- cancel работает;
- verification работает;
- direct Claude/Codex adapters работают.

---

# 9. Основной MVP

MVP должен доказать один сценарий:

```text
Телефон
  ↓
PWA
  ↓
TaskBridge
  ↓
зарегистрированный Git project
  ↓
Git worktree
  ↓
Pi
  ↓
локальная llama.cpp модель
  ↓
live events
  ↓
verification
  ↓
result
```

Обязательно:

- проект выбирается на телефоне;
- задача вводится на телефоне;
- Pi запускается без терминального UI;
- Pi работает в правильном `cwd`;
- live events идут на телефон;
- browser disconnect не останавливает задачу;
- пользователь может нажать STOP;
- TaskBridge корректно останавливает Pi;
- частичные изменения после cancel сохраняются;
- TaskBridge получает `git diff`;
- выполняется verification;
- результат доступен на телефоне.

---

# 10. MVP UI

## Главный экран

```text
┌─────────────────────────────────────────┐
│ TaskBridge                       ● PC   │
├─────────────────────────────────────────┤
│                                         │
│ Project                                 │
│ [ AndroidMrPlanner                ▼ ]   │
│                                         │
│ Executor                                │
│ [ Pi / Local                       ▼ ]   │
│                                         │
│ Task                                    │
│ ┌─────────────────────────────────────┐ │
│ │ Исправь проблему с ...             │ │
│ │                                     │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ [ + Attach files ]                      │
│                                         │
│                [ RUN ]                  │
└─────────────────────────────────────────┘
```

---

# 11. Экран выполнения Pi

```text
┌─────────────────────────────────────────┐
│ Task #42                       RUNNING  │
├─────────────────────────────────────────┤
│ Project      AndroidMrPlanner           │
│ Executor     Pi / Local Qwen            │
│ Elapsed      07:21                      │
│                                         │
│ Workspace                         ✓     │
│ Pi Agent                          ●     │
│ Verification                     —     │
│                                         │
│ Current                           │
│ Running: ./gradlew test                 │
│                                         │
│ Context                                  │
│ 42,120 / 65,536                          │
│ █████████████░░░░░░ 64%                 │
│                                         │
│ Compactions: 1                           │
│ Last: 51K → 19K                          │
│                                         │
│ [ STOP ] [ COMPACT ]                     │
│                                         │
│ Follow-up                                │
│ [ Не меняй публичный API...         ]   │
│ [ SEND ]                                 │
└─────────────────────────────────────────┘
```

---

# 12. Live events Pi

TaskBridge должен преобразовывать Pi events в единый формат.

Типы событий:

```text
SESSION_STARTED
MODEL_MESSAGE_START
MODEL_MESSAGE_UPDATE
MODEL_MESSAGE_END

TOOL_START
TOOL_UPDATE
TOOL_END

COMPACTION_START
COMPACTION_END

AGENT_STATE_CHANGED
AGENT_FINISHED
AGENT_ERROR
```

Пример UI:

```text
19:21  Session started
19:21  Reading repository
19:22  TOOL grep
19:22  TOOL read
19:24  TOOL edit
19:25  TOOL bash: ./gradlew test
19:28  Tests finished
19:28  Agent completed
```

---

# 13. Raw logs и events — разные вещи

Хранить отдельно:

## Structured Events

Используются UI.

```json
{
  "time": "...",
  "type": "TOOL_START",
  "tool": "bash",
  "summary": "./gradlew test"
}
```

## Raw log

Диагностика:

```text
Pi stdout/stderr
TaskBridge process logs
llama.cpp startup log
verification log
```

На телефоне по умолчанию показывать events.

Raw log открывать отдельной кнопкой.

---

# 14. Live transport

Для MVP рекомендуется SSE.

```text
GET /api/v1/tasks/{id}/events
```

Плюсы:

- проще WebSocket;
- автоматически переподключается;
- достаточен для server → phone event stream.

Для команд:

```text
POST /cancel
POST /follow-up
POST /compact
```

использовать обычный HTTP.

WebSocket можно добавить позже, если понадобится полноценный duplex transport.

---

# 15. Отмена Pi

Отмена является обязательной функцией MVP.

UI:

```text
[ STOP ]
```

Flow:

```text
Phone
 ↓
POST /api/v1/tasks/{id}/cancel
 ↓
TaskBridge
 ↓
state = CANCELLING
 ↓
PiAgentRunner.cancel()
 ↓
abort current agent operation
 ↓
при необходимости terminate owned child processes
 ↓
collect git diff
 ↓
save logs/events
 ↓
state = CANCELLED
```

После cancel workspace не удалять.

---

# 16. Результат отменённой задачи

Показывать:

```text
CANCELLED

Elapsed: 4m 18s

Pi успел:
- прочитать 12 файлов
- изменить 3 файла

Verification:
NOT RUN

[VIEW DIFF]
[VIEW EVENTS]
[VIEW RAW LOG]
[CONTINUE]
[DELETE WORKSPACE]
```

---

# 17. Follow-up во время работы

Если Pi runtime позволяет корректно принять follow-up:

```text
POST /api/v1/tasks/{id}/messages
```

```json
{
  "text": "Не меняй публичный API модуля domain"
}
```

TaskBridge передаёт сообщение в существующую Pi session.

Если в конкретном состоянии сообщение нельзя безопасно передать:

```text
409 RUN_NOT_ACCEPTING_MESSAGES
```

Нельзя терять сообщение молча.

---

# 18. Продолжение после завершения

После `SUCCEEDED`, `FAILED` или `CANCELLED` пользователь может нажать:

```text
[ CONTINUE ]
```

Создаётся новый run в той же logical task/session, если workspace ещё существует.

Модель:

```text
Task
 ├─ Run 1
 ├─ User follow-up
 └─ Run 2
```

Это позволяет не начинать каждый диалог с нуля.

---

# 19. Context UI

TaskBridge должен получать доступные метрики Pi и показывать:

```text
Current context tokens
Context window
Percentage
Number of compactions
Last compaction
```

Пример:

```text
Context: 42,120 / 65,536
64%

Compactions: 1
Last:
before 51,832
after 19,416
```

Если часть метрик недоступна:

```text
Context: UNKNOWN
```

Не вычислять фиктивные значения.

---

# 20. Compaction

TaskBridge не реализует собственный summarizer в MVP.

Pi отвечает за compaction.

TaskBridge должен поддержать:

```text
AUTO COMPACTION ON/OFF
COMPACT NOW
```

API:

```text
POST /api/v1/tasks/{id}/compact
```

Опционально:

```json
{
  "instructions": "Preserve current implementation decisions and test failures."
}
```

---

# 21. Рекомендуемая будущая compaction policy

Не обязательна MVP.

Для локальной модели с 64K:

```text
0–40K     normal
40–48K    warning
~48K      controlled compact
>52K      compact before accepting very large tool output
```

Цель после compaction:

```text
15–25K
```

Coding-oriented summary должна сохранять:

1. исходную цель;
2. принятые требования;
3. repository/workspace;
4. просмотренные файлы;
5. изменённые файлы;
6. важные symbols;
7. принятые решения;
8. выполненные команды;
9. test results;
10. текущие ошибки;
11. нерешённые гипотезы;
12. Git status;
13. следующие действия.

---

# 22. Project Registry

Пример:

```yaml
projects:
  android-mr-planner:
    name: AndroidMrPlanner
    path: G:\Android\AndroidStudioProjects\AndroidMrPlanner

  llama-server:
    name: LlamaServer
    path: G:\Android\AndroidStudioProjects\LlamaServer
```

Телефон работает только с `projectId`.

Никаких произвольных Windows path с телефона в MVP.

---

# 23. Workspace + Git worktree

Для coding-задачи по умолчанию:

```text
original repo
    │
    ├─ остаётся нетронут
    │
    └─ git worktree
          ↓
      Pi / Claude / Codex
```

Последовательность:

1. resolve project;
2. найти Git root;
3. получить source HEAD;
4. проверить dirty state;
5. создать task branch;
6. создать worktree;
7. задать agent `cwd`;
8. выполнить задачу;
9. получить diff;
10. проверить, что source checkout не изменился.

---

# 24. Dirty repository

MVP политика:

```text
dirty source repo → BLOCKED
```

Пользователь видит:

```text
Project has uncommitted changes.
Task was not started.
```

Позже можно добавить snapshot policy.

---

# 25. File uploads

Пользователь может одновременно:

- выбрать project;
- добавить дополнительные файлы;
- либо создать task только из файлов без project.

Upload:

```text
multipart
 ↓
*.partial
 ↓
fully written
 ↓
atomic rename
 ↓
task input
```

Без directory polling как основного механизма.

---

# 26. Runtime Manager для llama.cpp

MVP должен иметь минимальный runtime manager.

Интерфейс:

```ts
isReady(): Promise<boolean>
ensureRunning(): Promise<RuntimeInfo>
```

Логика:

```text
check localhost:8080
    │
    ├─ ready → use existing
    │
    └─ not ready
          ↓
       launch configured command
          ↓
       wait health
          ↓
       use
```

---

# 27. Внешний и managed llama.cpp

Состояния:

```text
STOPPED
STARTING
EXTERNAL_RUNNING
MANAGED_RUNNING
FAILED
```

Если пользователь сам запустил сервер:

```text
EXTERNAL_RUNNING
```

TaskBridge не должен его останавливать.

Если TaskBridge запустил сервер:

```text
MANAGED_RUNNING
```

его можно контролировать.

---

# 28. Runtime config

```yaml
localModel:
  endpoint: http://127.0.0.1:8080/v1

  managed:
    enabled: true
    executable: G:\AIModels\llamacpp\llama-server.exe
    model: G:\AIModels\...\model.gguf

    args:
      - -ngl
      - all
      - -c
      - "65536"
      - --flash-attn
      - "on"
```

MVP не должен заниматься:

- GPU scheduling;
- multi-model eviction;
- VRAM prediction;
- несколько тяжёлых runtime одновременно.

---

# 29. Persistent Task Store

SQLite — источник истины.

Минимальные таблицы:

```text
tasks
task_runs
task_events
projects
artifacts
```

Coroutine/in-memory queue не является источником истины.

---

# 30. Task state machine

```text
RECEIVING
QUEUED
PREPARING
PREFLIGHT
RUNNING
CANCELLING
VERIFYING
SUCCEEDED
FAILED
CANCELLED
BLOCKED
```

Позже:

```text
WAITING_USER
LIMIT_REACHED
AUTH_REQUIRED
ESCALATING
```

---

# 31. Browser disconnect

Требование:

```text
PWA закрыта
  ↓
TaskBridge продолжает run
  ↓
Pi продолжает работать
```

При повторном открытии UI:

1. `GET /tasks`;
2. получить RUNNING task;
3. подключиться к SSE;
4. показать текущий state.

---

# 32. Verification

Pi completion не является доказательством успеха.

После агента TaskBridge выполняет:

```text
git status
git diff
project-specific checks
```

Пример:

```yaml
projects:
  android-mr-planner:
    verification:
      quick:
        - "./gradlew test --console=plain"
```

---

# 33. Result

Собирать:

```text
agent status
duration
changed files
diff
verification result
events
raw logs
partial result
context statistics
compaction statistics
```

---

# 34. result.md

Пример:

```markdown
# Task Result

Status: SUCCEEDED
Executor: Pi / Local Qwen
Duration: 11m 42s

## Agent summary

...

## Changed files

- A.kt
- B.kt

## Verification

./gradlew test --console=plain

PASSED

## Context

Peak: 51K / 64K
Compactions: 1
After compaction: 19K

## Artifacts

- diff.patch
- pi-events.jsonl
- raw.log
```

---

# 35. Task API

## Create

```http
POST /api/v1/tasks
```

## Task info

```http
GET /api/v1/tasks/{id}
```

## Task history

```http
GET /api/v1/tasks
```

## Events

```http
GET /api/v1/tasks/{id}/events
```

## Cancel

```http
POST /api/v1/tasks/{id}/cancel
```

## Follow-up

```http
POST /api/v1/tasks/{id}/messages
```

## Compact

```http
POST /api/v1/tasks/{id}/compact
```

## Result

```http
GET /api/v1/tasks/{id}/result
```

## Artifacts

```http
GET /api/v1/tasks/{id}/artifacts
```

---

# 36. LAN

MVP:

```text
0.0.0.0:8787
```

Телефон:

```text
http://192.168.x.x:8787
```

Показывать URL при запуске TaskBridge.

Позже:

```text
taskbridge.local
QR pairing
```

---

# 37. Минимальная безопасность MVP

Так как это LAN-only:

не нужны:

- аккаунты;
- OAuth;
- облачный identity provider.

Но обязательны:

- bind только localhost/LAN;
- Windows Firewall Private Network;
- project allowlist;
- нет общего `/shell`;
- upload limits;
- archive traversal protection;
- sandbox cwd;
- redaction secrets;
- не отдавать env целиком в UI.

---

# 38. Первый PoC

Не начинать с PWA.

## Цель

Проверить:

```text
HTTP
 ↓
TaskBridge
 ↓
Pi
 ↓
existing llama.cpp
 ↓
project
```

Endpoint:

```http
POST /api/tasks
```

```json
{
  "project": "android-mr-planner",
  "prompt": "Прочитай структуру проекта и перечисли Gradle modules."
}
```

Запуск через curl.

### PoC готов, если

- Pi session стартует;
- cwd правильный;
- локальная Qwen отвечает;
- Pi tool events приходят;
- run завершается;
- TaskBridge получает финальный state.

---

# 39. MVP-1 — Pi Remote Control

После PoC добавить:

- PWA;
- SQLite;
- Project Registry;
- Git worktree;
- SSE;
- task history;
- STOP;
- follow-up;
- basic context view;
- manual compact;
- verification;
- result;
- raw log.

**Это основной MVP.**

---

# 40. MVP-1 acceptance tests

## A. Start

С телефона:

```text
Project: AndroidMrPlanner
Executor: Pi / Local
Task: Найди failing test.
```

Task стартует.

## B. Live events

Телефон показывает:

```text
read
grep
edit
bash
```

без screen scraping.

## C. Disconnect

Закрыть браузер.

Pi продолжает работу.

После возврата status восстанавливается.

## D. Cancel

Нажать STOP во время `gradlew`.

Pi и дочерний процесс останавливаются.

Task:

```text
CANCELLED
```

Diff сохраняется.

## E. Worktree

Основной checkout не изменён.

## F. Verification

После Pi автоматически запускается configured check.

## G. Compaction

Если Pi выполняет compaction, UI получает event.

Manual compact также работает.

## H. Follow-up

Во время или после run пользователь может отправить дополнительную инструкцию.

---

# 41. MVP-2 — Direct Claude Code

Добавить:

```text
Executor = CLAUDE
```

TaskBridge запускает Claude Code непосредственно:

```text
TaskBridge
 ↓
Claude Code
```

а не:

```text
TaskBridge → Pi → Claude
```

Использовать тот же:

- project;
- worktree;
- task state;
- events wrapper;
- cancel;
- verification;
- result.

---

# 42. MVP-3 — Direct Codex

То же для:

```text
Executor = CODEX
```

---

# 43. Engine health

После появления Claude/Codex добавить:

```text
PI_LOCAL     READY
CLAUDE       READY
CODEX        LIMIT_REACHED
```

States:

```text
READY
UNAVAILABLE
AUTH_REQUIRED
LIMIT_REACHED
RATE_LIMITED
UNKNOWN
```

Не выдумывать точные remaining quota, если API их не предоставляет.

---

# 44. AUTO Dispatcher

Только после MVP-1/2/3.

Добавить маленькую CPU-модель.

Она не получает shell.

Доступные действия:

```text
list_projects
get_executor_status
select_executor
create_plan
```

Пример результата:

```json
{
  "executor": "CLAUDE",
  "projectId": "android-mr-planner",
  "reason": "Architecture-level task",
  "confidence": 0.91
}
```

---

# 45. Escalation policy

Модель не должна бесконтрольно тратить Claude/Codex.

Рекомендуемые режимы:

## MANUAL

Всегда явный executor.

## LOCAL_ONLY

Только Pi/local.

## LOCAL_FIRST

```text
Pi
 ↓
verification pass? → DONE
 ↓ no
one retry
 ↓ fail
offer escalation
```

## QUALITY_FIRST

Сразу выбранный сильный external executor.

---

# 46. Автоматическая escalation

Допустима только по правилам:

- пользователь заранее разрешил;
- engine preflight OK;
- fallback policy задана;
- новая попытка работает в чистом workspace, если предыдущая внесла изменения.

Не запускать Claude/Codex только потому, что Qwen написала «сложно».

---

# 47. KMP Android

После стабилизации API PWA заменяется или дополняется KMP.

KMP получает:

- Task Composer;
- Project picker;
- Executor picker;
- live events;
- context meter;
- STOP;
- COMPACT;
- follow-up;
- task history;
- diff/result;
- Android Share Target.

Backend не меняется.

---

# 48. Android Share Target

Из Android:

```text
Файл
 ↓
Поделиться
 ↓
TaskBridge
```

Открывается:

```text
Attached:
project.zip

Task:
[ Проанализируй... ]

Executor:
[ Pi / Local ]

[ SEND ]
```

---

# 49. Project-less task

TaskBridge должен поддерживать:

```text
projectId = null
files != empty
```

Создаётся обычный workspace:

```text
runs/<id>/workspace
```

Pi запускается там.

---

# 50. Windows tray host

Production:

```text
TaskBridge
● Running

URL:
http://192.168.1.10:8787

Pi: idle
llama.cpp: running
Tasks: 1

[Open UI]
[Stop Server]
```

---

# 51. Recovery

После restart TaskBridge:

- completed tasks восстанавливаются из SQLite;
- events доступны;
- workspace сохраняется;
- RUNNING task анализируется отдельно.

MVP может помечать оборванный run:

```text
FAILED_RECOVERY
```

В production можно добавить reattach, если Pi/runtime это позволяют безопасно.

---

# 52. Логи

На каждый run:

```text
runs/<task>/<run>/
├─ request.json
├─ events.jsonl
├─ pi.raw.log
├─ runtime.log
├─ verification.log
├─ diff.patch
├─ result.json
└─ result.md
```

---

# 53. Error taxonomy

```text
PROJECT_NOT_FOUND
PROJECT_DIRTY
WORKTREE_FAILED
UPLOAD_FAILED
PI_NOT_AVAILABLE
PI_START_FAILED
PI_SESSION_FAILED
LOCAL_RUNTIME_FAILED
CLAUDE_NOT_AVAILABLE
CODEX_NOT_AVAILABLE
AUTH_REQUIRED
LIMIT_REACHED
PROCESS_TIMEOUT
PROCESS_CRASH
VERIFICATION_FAILED
CANCELLED_BY_USER
FAILED_RECOVERY
INTERNAL_ERROR
```

---

# 54. Очередь

MVP:

```text
concurrency = 1
```

Persistent queue хранится в SQLite.

Это оптимально для одного GPU.

---

# 55. Idle behaviour

TaskBridge:

```text
всегда запущен
почти 0 CPU
```

Pi:

```text
создаётся/активируется для task/session
```

Большая локальная модель:

```text
использовать уже запущенную
или запускать по требованию
```

Маленькая dispatcher-модель:

```text
не запускать до появления AUTO
```

---

# 56. Что НЕ входит в MVP-1

Не делать:

- OpenClaw integration;
- Dispatcher LLM;
- AUTO;
- Claude;
- Codex;
- fallback;
- GPU scheduler;
- multi-model manager;
- plugin marketplace;
- vector DB;
- complex auth;
- external internet access;
- Telegram;
- KMP;
- automatic merge;
- advanced project indexing.

---

# 57. Порядок реализации

```text
Phase 0   TypeScript skeleton
Phase 1   Pi integration PoC
Phase 2   Task domain + SQLite
Phase 3   Project Registry
Phase 4   Git worktree
Phase 5   Event persistence
Phase 6   SSE
Phase 7   Cancel
Phase 8   Follow-up
Phase 9   Context/compaction UI
Phase 10  Verification
Phase 11  PWA
──────────── MVP-1 ────────────
Phase 12  Claude Code
Phase 13  Codex
Phase 14  Engine health/quota
──────────── MVP-2/3 ──────────
Phase 15  Dispatcher
Phase 16  AUTO
Phase 17  Escalation
Phase 18  KMP
Phase 19  Pairing/mDNS
Phase 20  Apply workflow
Phase 21  Recovery/cleanup
Phase 22  Windows tray/installer
──────────── 1.0 ──────────────
```

---

# 58. Первый практический milestone

Не нужно сразу писать весь сервер.

Первый milestone должен состоять из:

```text
server.ts
PiAgentRunner.ts
projects.yaml
```

И endpoint:

```text
POST /api/tasks
```

Сценарий:

```text
curl
 ↓
TaskBridge
 ↓
resolve project
 ↓
start Pi
 ↓
Pi uses localhost:8080
 ↓
stream events to server log
 ↓
return final result
```

Если это работает стабильно, архитектура подтверждена.

---

# 59. Второй milestone

Добавить:

```text
SQLite
Git worktree
Cancel
SSE
```

После него можно открыть PWA на телефоне.

---

# 60. Definition of Done MVP-1

MVP-1 считается готовым только если:

- телефон видит TaskBridge по Wi‑Fi;
- пользователь выбирает project;
- пользователь вводит prompt;
- TaskBridge создаёт worktree;
- Pi запускается в worktree;
- Pi использует локальный llama.cpp;
- события Pi видны live;
- tool execution виден live;
- context отображается, если Pi даёт метрики;
- compaction events отображаются;
- manual compact доступен;
- STOP реально останавливает run;
- дочерние команды тоже прекращаются;
- browser disconnect не ломает run;
- после возврата UI восстанавливает status;
- diff сохраняется;
- verification запускается;
- result доступен на телефоне;
- основной checkout проекта не изменяется.

---

# 61. Definition of Done 1.0

Готовый продукт:

```text
PWA + KMP
TaskBridge
Persistent queue
Project Registry
Worktree isolation
Pi/local
Claude direct
Codex direct
live events
context UI
compaction control
cancel
follow-up
history
verification
AUTO
escalation
quota/auth diagnostics
runtime lifecycle
apply workflow
recovery
cleanup
LAN discovery
simple pairing
Windows autostart
```

---

# 62. Главный продуктовый принцип

Пользователь не должен «удалённо работать в терминале».

Пользователь отправляет намерение:

```text
Исправь stale plan bug и запусти тесты.
```

А UI показывает понятное состояние:

```text
Preparing workspace
Reading project
Editing 3 files
Running tests
Compacting context
Tests passed
Done
```

При необходимости всегда доступны:

```text
View events
View raw log
Stop
Send follow-up
Compact
View diff
```

---

# 63. Финальная архитектура

```text
                         PHONE
                           │
                   PWA / KMP
                           │
                        Wi‑Fi
                           ▼
┌────────────────────────────────────────────────────────────┐
│                        TASKBRIDGE                          │
│                                                            │
│ HTTP API                                                   │
│ Task Store                                                 │
│ Persistent Queue                                           │
│ Project Registry                                           │
│ Workspace / Git Worktree                                   │
│ Event Stream                                               │
│ Context UI                                                 │
│ Cancel / Follow-up / Compact                               │
│ Verification                                               │
│ Result / Artifacts                                         │
│                                                            │
│ Agent Manager                                              │
│    │                                                       │
│    ├──────── PiAgentRunner ──────► Pi ─────► llama.cpp     │
│    │                                                       │
│    ├──────── ClaudeCodeRunner ───► Claude Code             │
│    │                                                       │
│    └──────── CodexRunner ────────► Codex                   │
└────────────────────────────────────────────────────────────┘
```

TaskBridge является **тонким локальным control plane над готовыми coding agents**, а не заменой Pi/OpenClaw.
