Да. Я бы зафиксировал цель так:

> **TaskBridge не должен становиться ещё одним coding-agent.**  
> Он должен стать **control plane для проектов, памяти, контекста и нескольких agent runtime**, где Pi и OMP — сменные исполнительные движки.

Тогда получится не Frankenstein, а слоистая система:

```text
                    ┌─────────────────────────────┐
                    │          TaskBridge         │
                    │  Project / Work / Memory    │
                    └──────────────┬──────────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          │                        │                        │
     Context Layer            Agent Runtime            Artifacts
          │                        │                        │
   memory / files / AST       Pi / OMP / future       logs / diff /
          │                        │                    tool output
          └────────────────────────┼────────────────────────┘
                                   │
                         Git workspace/worktree
```

OMP уже предоставляет очень сильные primitives: RPC по JSONL, native AST/search, LSP, structural summaries, artifact spill, subagents и несколько вариантов памяти. [GitHub](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md?utm_source=chatgpt.com)

Но **источником истины остаётся TaskBridge**.

---

# 0. Архитектурные правила — зафиксировать до кода

Это самое важное против Frankenstein.

### TaskBridge владеет

```text
Project
Work Item
Session
Run
workspace/worktree
resume lineage
verification
artifacts
project memory policy
UI/API
```

### Agent runtime владеет

```text
model conversation
tool execution
agent-specific context
compaction
agent-specific session file
subagents, если runtime их поддерживает
```

### Git владеет

```text
реальным состоянием кода
HEAD
diff
branches
worktrees
```

### `pi-memory-md` владеет

```text
долговременными знаниями проекта
```

### `project-md` владеет только

```text
выборочным представлением файлов
```

Не даём двум подсистемам владеть одной сущностью.

---

# Этап 1. Нормальная память проектов

Это фундамент всего остального.

## MR-01 — Project Dashboard

Мы его уже начали.

Цель — перейти от:

```text
список сессий
```

к:

```text
Project
   ↓
Sessions
   ↓
Work
```

### Backend

Проект остаётся зарегистрированным объектом конфигурации:

```ts
Project {
    id
    name
    path
    useWorktree
}
```

SQLite хранит только UI/runtime metadata, которые действительно принадлежат TaskBridge:

```sql
project_view_preferences (
    project_id TEXT PRIMARY KEY,
    pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
)
```

**Не копировать** `path`, `name` и прочие project config поля в SQLite.

### UI

Новый уровень навигации:

```text
Projects
   ↓
Project Dashboard
   ↓
Sessions
```

Dashboard показывает:

```text
TaskBridge

Active work        3
Sessions          41
Running            2
Needs attention    1
Last activity      8 min

Recent sessions
...
```

Android/Desktop/PWA должны использовать одинаковую модель API.

---

# MR-02 — Work Items

Вот здесь начинается настоящая память разработки.

## Новая сущность

```ts
WorkItem {
    id
    projectId

    title
    goal

    status
    priority

    acceptanceCriteria[]

    createdAt
    updatedAt
    completedAt?

    tags[]
}
```

Статусы достаточно простые:

```text
BACKLOG
READY
IN_PROGRESS
BLOCKED
DONE
CANCELLED
```

Не надо строить Jira.

### SQLite

```sql
work_items (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,

    title TEXT NOT NULL,
    goal TEXT,

    status TEXT NOT NULL,
    priority INTEGER,

    acceptance_json TEXT,
    tags_json TEXT,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);
```

### Что туда нельзя складывать

Не помещаем:

```text
полный prompt
историю чата
diff
memory dump
все tool results
resumeContext
```

Work Item — **семантическое состояние работы**, а не контейнер всего подряд.

---

# MR-03 — Work Item ↔ Sessions

Это критическая часть.

Одна задача разработки должна переживать несколько независимых agent sessions.

```text
Work Item
│
├── Pi session A
├── Pi session B
├── OMP session C
└── Review session D
```

### Таблица

```sql
work_item_sessions (
    work_item_id TEXT NOT NULL,
    session_id TEXT NOT NULL,

    relation TEXT NOT NULL DEFAULT 'implementation',

    created_at TEXT NOT NULL,

    PRIMARY KEY(work_item_id, session_id)
);
```

`relation` пригодится позже:

```text
implementation
investigation
review
verification
resume
```

### Очень важно

Не использовать существующий `runs` для этого.

Сейчас:

```text
Session
 └── Run 1
 └── Run 2
```

А нужно:

```text
Work Item
 ├── Session A
 │    ├── Run 1
 │    └── Run 2
 └── Session B
      └── Run 3
```

Это две разные иерархии.

---

# MR-04 — Resume Engine

Это главный этап проекта.

После него длинные контексты перестают быть проблемой.

## Пользователь нажимает

```text
Continue task
```

и выбирает:

```text
Continue current session

или

Start clean session
```

Во втором случае TaskBridge строит **не сохранённый Handoff**, а вычисляемый:

```ts
ResumeContext
```

Например:

```json
{
  "workItem": {
    "title": "Project Dashboard",
    "goal": "...",
    "acceptanceCriteria": []
  },

  "previousSessions": [],

  "workspace": {
    "strategy": "fresh-worktree",
    "head": "abc123",
    "changedFiles": []
  },

  "verification": {},

  "relevantArtifacts": [],

  "memory": {
    "mode": "native"
  }
}
```

## Resume Builder

Создать отдельный слой:

```text
src/resume/
    resume-builder.mjs
    resume-preview.mjs
    resume-validator.mjs
    resume-renderer.mjs
```

Не класть это в огромный `task-manager.mjs`.

### Pipeline

```text
Work Item
   │
   ├── sessions
   ├── session results
   ├── verification state
   ├── Git state
   ├── selected artifacts
   └── memory strategy
          ↓
    ResumeBuilder
          ↓
     ResumeContext
          ↓
        Preview
          ↓
       Revalidate
          ↓
    create session
```

---

# Resume Preview

Перед запуском показываем:

```text
Continue "Project Dashboard"

Context
✓ Goal
✓ Acceptance criteria
✓ Session A summary
✓ Session B result
✓ Git diff
✓ Verification

Workspace
○ Fresh worktree
● Reuse current worktree
○ Apply patch

Memory
● Native project memory
○ Off

Files
3 selected

Estimated context: ~8.7k tokens

[Start]
```

### Preview ≠ Launch

При нажатии Start повторно проверять:

```text
HEAD не изменился?
worktree существует?
artifact существует?
session существует?
project-md доступен?
memory backend доступен?
```

Если изменилось:

```text
Context changed since preview
```

и показываем diff выбора.

---

# Этап 2. Session Recap

Здесь берём хорошую идею OMP `archive/recap`, но не копируем его хранилище.

В актуальном OMP `archive` умеет просматривать прошлые проекты/сессии, prompts и recap journals. [GitHub](https://github.com/can1357/oh-my-pi/releases?utm_source=chatgpt.com)

## Наш вариант

После осмысленного состояния сессии создаётся:

```ts
SessionRecap {
    objective
    accomplished[]
    changedFiles[]
    decisions[]
    verification[]
    remaining[]
    blockers[]
}
```

Пример:

```text
Objective
Fix Android history crash.

Done
- cursor guard
- reducer dedup
- multi-page loading

Verification
- client:jvmTest 63/63
- shared:jvmTest 145/145
- emulator PASS

Remaining
- physical-device verification
```

### Где хранить

Можно в:

```text
tasks/<session>/artifacts/recap.json
tasks/<session>/artifacts/recap.md
```

SQLite максимум хранит:

```text
artifact reference
updatedAt
version
```

Сам recap не должен становиться новой сложной БД.

### Resume использует

```text
recap
```

вместо полного transcript.

Вот это даёт огромную экономию токенов.

---

# Этап 3. Project Memory

Теперь отделяем:

```text
что было в конкретной работе
```

от:

```text
что проект должен помнить месяцами
```

## Долговременная память

Оставляем:

```text
pi-memory-md
```

как canonical backend.

Примеры:

```text
TaskBridge uses KMP Android/Desktop.

One Work Item may contain multiple sessions.

ResumeContext is ephemeral.

Missing worktree must never silently fall back to main checkout.

TURN_TRUNCATED keeps the event cursor monotonic.
```

А не:

```text
Сегодня тест 31 упал.

Агент открыл ChatScreen.kt.

Сборка заняла 8 минут.
```

---

# MR-05 — Memory Adapter

TaskBridge не должен знать внутреннее устройство `pi-memory-md`.

Делаем интерфейс:

```ts
class ProjectMemoryProvider {
    async status(project)
    async summary(project)
    async search(project, query)
    async inspect(project)
}
```

Первая реализация:

```text
PiMemoryMdProvider
```

Позже потенциально:

```text
OmpMemoryProvider
```

но **не одновременно как два источника истины**.

### Важно

Provider API сначала **read-only**.

Никаких:

```text
delete
rewrite
automatic retain
```

---

# MR-06 — анализ реального memory injection

Это уже был наш запланированный этап.

Нужно измерить:

```text
какая memory реально попадает Pi
сколько токенов
что дублируется
что устарело
что не используется
```

И получить метрики:

```text
memory injected chars
estimated tokens
entries used
memory hit rate
stale entries
```

После этого можно решать, надо ли что-нибудь оптимизировать.

---

# MR-07 — Project Knowledge Inspector

UI:

```text
Project
└── Knowledge
```

Пример:

```text
Project Knowledge

Injected now
  2,841 tokens

Architecture                    13
Decisions                        8
Patterns                         5
Known issues                     3

Search
[ worktree handling________ ]

Results
──────────────────────────────
Worktree fallback is forbidden...
ResumeContext is ephemeral...
```

Также:

```text
Source
Updated
Used recently
Possibly stale
```

### Никакой кнопки DELETE на первом этапе.

---

# MR-08 — Memory Suggestions

Вот здесь берём хорошую философию OMP memory.

OMP умеет извлекать durable signal из старых sessions и консолидировать его в project memory; его документация отдельно подчёркивает, что memory должна считаться эвристическим контекстом, а текущий repo state имеет приоритет. [GitHub](https://github.com/can1357/oh-my-pi/blob/main/docs/memory.md?utm_source=chatgpt.com)

TaskBridge делает безопаснее:

```text
Session finished
       ↓
Knowledge candidate extractor
       ↓
Suggestions
```

Пример:

```text
Potential durable knowledge

☐ History pagination uses before=seq
☐ Android chat cache must be byte bounded
☐ Work Items may contain multiple Pi sessions

[Save selected]
```

Только после подтверждения пользователя memory provider получает write.

---

# Этап 4. Context Broker

Это один из самых важных слоёв гибрида.

Не Pi решает самостоятельно всё про контекст.

Не OMP.

Не `project-md`.

Создаём:

```text
ContextBroker
```

## Его задача

Получает:

```ts
ContextRequest {
    projectId
    workItemId
    sessionId?

    task
    tokenBudget

    capabilities
}
```

Возвращает:

```ts
ContextBundle {
    workItem
    resume
    memory
    files
    symbols
    artifacts
}
```

---

# Политика бюджета

Например:

```text
Resume                           2k
Project memory                   2k
Relevant code                    8k
Artifacts                        2k
Reserve for agent               ...
```

Не:

```text
вот тебе весь проект на 150k
```

---

# MR-09 — selective project-md

`project-md` здесь становится одним из provider'ов:

```text
ContextProvider
├── ProjectMdProvider
├── MemoryProvider
├── GitProvider
├── ArtifactProvider
└── CodeIntelligenceProvider
```

Не самостоятельной системой памяти.

### Используем

```text
list_project_files
project_summary
generate_markdown(selectedFiles)
```

### Не используем автоматически

```text
extract_markdown
```

особенно пока path restriction отключён.

---

# Этап 5. Code Intelligence

Вот здесь начинаем брать самое полезное из OMP.

OMP имеет native `ast_grep`, `ast_edit`, tree-sitter, structural summarization и LSP. Его native layer содержит отдельные операции для AST, поиска и code summarization. [GitHub](https://github.com/pi-packages/can1357-oh-my-pi/blob/main/README.md?utm_source=chatgpt.com)

## MR-10 — Code Search Provider

Вводим абстракцию:

```ts
CodeSearchProvider {
    textSearch()
    symbolSearch()
    references()
    structure()
}
```

### Routing

```text
"найди строку ошибки"
        ↓
grep

"где вызывается loadOlder"
        ↓
AST / LSP references

"покажи классы, реализующие Foo"
        ↓
AST

"найди файл"
        ↓
glob
```

---

# AST first policy

Агенту можно передавать tool guidance:

```text
Symbol/reference query:
    LSP / AST first

Exact text/log query:
    grep

File discovery:
    glob

Do not recursively grep the whole repository
when structural search can answer.
```

Это непосредственно решает твою проблему медленного grep.

---

# MR-11 — Structural Read

Очень сильная идея OMP.

У него `read.summarize.enabled=true` может отдавать структуру исходника вместо полного огромного файла. [GitHub](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md?utm_source=chatgpt.com)

Для:

```text
ChatScreen.kt
82 KB
```

сначала:

```text
ChatScreen.kt

ChatScreen()
MessageList()
ChatTopBar()
ApprovalCard()
...
```

Дальше агент:

```text
read symbol MessageList
```

### Наш API

```ts
code.structure(path)

code.readSymbol(
    path,
    symbol
)
```

### Выигрыш

Особенно большой на локальном Qwen:

```text
меньше PP
меньше context pollution
меньше потерянных деталей
быстрее reasoning
```

---

# MR-12 — AST Edit

Не начинать с OMP hashline.

Начать с более универсального:

```text
AST search
AST preview edit
AST apply
```

OMP `ast_edit` тоже работает preview-first и только затем применяет структурное изменение. [GitHub](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/ast-edit.md?utm_source=chatgpt.com)

### Наш контракт

```ts
StructuralEditProposal {
    id
    files[]
    replacements
    preview
    stale
}
```

Pipeline:

```text
Agent
 ↓
AST edit request
 ↓
Preview
 ↓
validate current files
 ↓
apply
 ↓
LSP diagnostics
```

---

# MR-13 — LSP provider

Для Kotlin особенно важно.

Функции:

```text
symbols
references
definition
implementation
rename
diagnostics
```

OMP после edits умеет запускать diagnostics; у него `lsp.diagnosticsOnWrite=true` по умолчанию. [GitHub](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md?utm_source=chatgpt.com)

Для TaskBridge:

```text
Edit
 ↓
LSP diagnostics
 ↓
compiler/tests
```

Это значительно лучше:

```text
regex replace
 ↓
надеяться
```

---

# Этап 6. Artifact Architecture

Я поставил бы это **до OMP runtime**.

Потому что этим будут пользоваться и Pi, и OMP.

## MR-14 — Tool Output Spill

OMP делает очень разумную вещь: большие tool outputs уводятся из session JSONL в session-scoped artifacts, а модели остаётся bounded preview. [GitHub](https://github.com/can1357/oh-my-pi/blob/main/docs/blob-artifact-architecture.md?utm_source=chatgpt.com)

TaskBridge уже умеет писать artifacts через `TaskStore.writeArtifact()`.

Нужно поднять это на уровень полноценного контракта.

---

# Новый ArtifactStore

```ts
Artifact {
    id
    sessionId

    type
    mimeType

    bytes
    sha256

    path

    preview?
    createdAt
}
```

Типы:

```text
tool-output
verification-log
diff
model-output
subagent-report
context-bundle
attachment
```

---

# Spill policy

Например:

```text
< 32 KB
    inline

32–256 KB
    head + tail + artifact

> 256 KB
    metadata + small preview + artifact
```

Не фиксировать эти значения как догму — сделать config.

### Event

Вместо:

```json
{
  "output": "800 KB..."
}
```

пишем:

```json
{
  "preview": "...",
  "truncated": true,
  "bytes": 827121,
  "artifactId": "art-123"
}
```

---

# Android

UI:

```text
Tool result
──────────────────
first 40 lines
...
last 20 lines

827 KB · truncated

[Open full output]
```

Полный файл загружается **только при нажатии**.

Это одновременно уменьшает:

```text
SQLite
SSE
network traffic
ChatReducer
Compose memory
session cache
Resume tokens
```

---

# Blob storage

Позже можно взять вторую часть OMP architecture:

```text
large binary/image
       ↓
sha256 blob store
       ↓
blob ref
```

OMP разделяет content-addressed blobs и session artifacts, что хорошо масштабируется. [GitHub](https://github.com/can1357/oh-my-pi/blob/main/docs/blob-artifact-architecture.md?utm_source=chatgpt.com)

Для TaskBridge:

```text
data/
 ├── blobs/
 │    └── sha256...
 │
 └── tasks/
      └── <session>/
           └── artifacts/
```

Но это отдельный MR после text spill.

---

# Этап 7. Agent Runtime Contract

Вот здесь начинаем путь к OMP.

И хорошая новость: фундамент **уже частично существует**.

В TaskBridge есть:

```text
src/runners/pi-runner.mjs
```

и там уже заявлена идея:

```text
runner abstraction
future Claude/Codex
capability-aware controls
RunnerRegistry
```

То есть не надо начинать заново.

---

# MR-15 — довести Runner abstraction до настоящего runtime API

Сейчас `PiRunner` — тонкая оболочка и пока не владеет execution flow.

Нужно сформировать стабильный интерфейс.

```ts
AgentRuntime {
    id
    capabilities

    createSession()
    resumeSession()
    closeSession()

    prompt()
    followUp()
    steer()

    cancel()

    compact?()

    setModel?()
    setThinking?()

    getState()

    events()
}
```

---

# Capability model

Не делать:

```text
if (runtime === "omp")
```

по всему TaskBridge.

Нужно:

```ts
capabilities = {
    steer: true,
    compact: true,

    modelSwitch: true,
    thinking: true,

    approvals: true,

    resume: true,

    subagents: false,
    structuralSearch: false,
    lsp: false,

    nativeMemory: true
}
```

UI спрашивает:

```text
runner.can("compact")
```

и показывает кнопку.

---

# Canonical AgentEvent

Самое важное решение интеграции.

Pi и OMP имеют разные wire protocols.

TaskBridge UI никогда не должен их видеть.

```ts
AgentEvent =
    SessionStarted
    | UserMessage
    | AssistantStarted
    | AssistantDelta
    | AssistantFinished

    | ThinkingDelta

    | ToolStarted
    | ToolUpdated
    | ToolFinished

    | ApprovalRequested

    | UsageUpdated

    | AgentSettled

    | RuntimeError
```

---

# Адаптер Pi

```text
Pi JSONL
 ↓
PiEventAdapter
 ↓
AgentEvent
```

### OMP

```text
OMP JSONL
 ↓
OmpEventAdapter
 ↓
AgentEvent
```

Отсюда:

```text
ChatReducer
```

должен постепенно начать работать не с `PI_EVENT`, а с canonical events.

Это важнее самого OMP adapter.

---

# Этап 8. Runtime session identity

Сейчас исторически:

```text
Task ≈ Session
```

Это нужно разорвать **до OMP**.

## Session

```ts
Session {
    id

    projectId
    workItemId?

    runtime: "pi" | "omp"

    runtimeSessionRef

    workspaceRef

    createdAt
    state
}
```

`runtimeSessionRef`:

Pi:

```text
~/.pi/...jsonl
```

OMP:

```text
OMP session file / id
```

TaskBridge не интерпретирует идентичность runtime через filesystem assumptions.

---

# Этап 9. OMP integration — read-only spike

Не начинать сразу с production.

## MR-16 — OMP probe

OMP официально предоставляет:

```bash
omp --mode rpc
```

как JSONL protocol over stdin/stdout, а современные версии также публикуют machine-readable wire schema и generated-client support. [GitHub](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md?utm_source=chatgpt.com)

Сначала небольшой адаптер:

```text
src/runners/omp/
    omp-rpc-session.mjs
    omp-event-adapter.mjs
    omp-runner.mjs
```

Функции spike:

```text
start
ready
prompt
receive text
tool events
cancel
finish
close
```

Без:

```text
subagents
memory
isolation
archive
```

---

# Тест fixture

Как для Pi:

```text
tests/fixtures/omp/
```

Записываем real RPC trace:

```text
startup.jsonl
simple-prompt.jsonl
tool-call.jsonl
cancel.jsonl
error.jsonl
```

И тестируем adapter без запуска настоящего OMP.

---

# MR-17 — OMP as second runtime

Теперь в UI:

```text
New session

Agent
┌─────────────────────────┐
│ Pi                      │
│ Oh My Pi                │
└─────────────────────────┘
```

При выборе:

```text
runtimeId = omp
```

Work Item, workspace, Git, artifacts, verification — **те же самые**.

Меняется только executor.

---

# OMP capability profile

Пример:

```ts
OMP_CAPABILITIES = {
    steer: true,
    resume: true,

    modelSwitch: true,
    thinking: true,

    approvals: true,

    structuralSearch: true,
    structuralEdit: true,
    lsp: true,

    subagents: true,
    archive: true,

    compact: ...,
}
```

Не угадывать возможности — capability negotiation при startup.

---

# Этап 10. Не дублировать memory OMP

OMP сейчас имеет несколько memory backend'ов: local summaries, Hindsight, Mnemopi, Sharpshooter и т.д. [GitHub](https://github.com/can1357/oh-my-pi/blob/main/docs/memory.md?utm_source=chatgpt.com)

В TaskBridge по умолчанию:

```text
OMP memory = OFF
```

Почему?

Иначе:

```text
pi-memory-md
+
OMP local memory
+
TaskBridge Work Items
```

дадут конфликтующие представления прошлого.

---

# При использовании OMP

TaskBridge передаёт:

```text
ResumeContext
+
canonical project memory
```

а OMP используется как execution engine.

Позже можно разрешить режим:

```text
Runtime-native memory
```

но пользователь должен явно его выбрать.

---

# Этап 11. OMP native tools

После успешного runtime adapter появляется очень интересный выбор.

Не обязательно портировать:

```text
ast_grep
ast_edit
LSP
```

в TaskBridge.

Если runtime = OMP:

```text
OMP использует свои native tools
```

Если runtime = Pi:

```text
TaskBridge tool provider
```

То есть:

```text
             Code Intelligence
                    │
          ┌─────────┴─────────┐
          │                   │
         Pi                  OMP
          │                   │
TaskBridge tools        OMP native
```

Но результат нормализуется.

Так мы **не дублируем OMP**.

---

# Этап 12. Subagents

OMP умеет task agents, включая `scout`, `reviewer`, `security-reviewer`, изоляцию и отдельные artifacts. [GitHub](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md?utm_source=chatgpt.com)

Это стоит использовать после стабильной интеграции.

## Mapping

OMP internal subagent:

```text
OMP Session
   ├── Scout
   ├── Reviewer
   └── Task
```

TaskBridge не обязан превращать каждый из них в Session.

Это **внутренние child executions**.

Отображение:

```text
Session
  └── Agents
       Scout        done
       Reviewer     running
```

---

# Но независимая review работа — Session

Есть разница:

```text
OMP child reviewer
```

и:

```text
TaskBridge Review Session
```

Первое — внутренний implementation detail runtime.

Второе — самостоятельная работа:

```text
Work Item
 ├── Implementation session
 └── Review session
```

Это важная граница.

---

# Этап 13. Review workflow

Добавить:

```text
Review changes
```

TaskBridge:

```text
Work Item
   ↓
current Git diff
   ↓
new read-only/isolated session
   ↓
Reviewer
```

Исполнителем может быть:

```text
Pi
OMP reviewer
Codex later
```

Результат:

```ts
ReviewResult {
    verdict
    findings[]
    severity
    files[]
}
```

---

# Этап 14. OMP Archive ideas

OMP теперь имеет read-only `archive`, который умеет искать прошлые sessions и читать recaps. [GitHub](https://github.com/can1357/oh-my-pi/releases?utm_source=chatgpt.com)

У нас аналог должен быть выше runtime:

```text
TaskBridge Project Archive
```

Поиск:

```text
"android history crash"
```

ищет:

```text
Work Items
Session Recaps
Verification
Artifacts metadata
Memory
```

**Не full transcript по умолчанию.**

Full history — только второй этап поиска.

---

# Этап 15. Context observability

Это обязательно, иначе через год мы не поймём, почему агент что-то знает.

Для каждой сессии:

```text
Context Inspector
```

Например:

```text
Prompt context                  13.8k

System                            2.4k
Resume                            2.1k
Project memory                    1.8k
AGENTS / rules                    1.0k
Relevant files                    5.6k
Artifacts                         0.9k

Excluded
34 files
3 old sessions
2 stale memories
```

И желательно:

```text
Why included?
```

Это один из лучших способов избежать context Frankenstein.

---

# Этап 16. Context provenance

Каждый кусок контекста:

```ts
ContextItem {
    source
    sourceId
    kind

    chars
    estimatedTokens

    reason
    priority
    freshness

    hash
}
```

Например:

```json
{
  "kind": "memory",
  "source": "pi-memory-md",
  "reason": "matched worktree policy",
  "estimatedTokens": 91
}
```

Можно потом реально анализировать:

> эта память помогла или только съедала context?

---

# Этап 17. Project Rules

Здесь можно взять идею `.omp/AGENTS.md` и `.omp/RULES.md`. OMP отделяет project context от sticky rules. [GitHub](https://github.com/can1357/oh-my-pi/blob/main/docs/context-files.md?utm_source=chatgpt.com)

Но сделать runtime-neutral.

Например:

```text
.taskbridge/
    PROJECT.md
    RULES.md
```

`PROJECT.md`:

```text
архитектура
build commands
module map
```

`RULES.md`:

```text
никогда не менять X
не запускать Y
использовать Z
```

TaskBridge может транслировать их:

Pi:

```text
Pi context
```

OMP:

```text
OMP context
```

Но **не заводить `.pi`, `.omp`, `.claude`, `.taskbridge` с одинаковыми копиями**.

---

# Этап 18. Tool policy

Также runtime-neutral.

Пример:

```yaml
code:
  search:
    symbols: lsp
    structure: ast
    text: grep

  edits:
    prefer: ast
    fallback: patch

verification:
  required: true

artifacts:
  spillThresholdKb: 64
```

Это TaskBridge project policy.

Adapters конвертируют её в runtime-specific config.

---

# Этап 19. OMP isolation — не переносить сейчас

OMP умеет:

```text
APFS
Btrfs
ZFS
reflink
overlayfs
ProjFS
Git worktree fallback
``` :chatgpt-content-reference{index="14"}


Очень мощно.

Но TaskBridge сейчас должен оставить:

```text
Git worktree
```

как canonical workspace mechanism.

Почему:

```text
predictable
cross-runtime
Git-native
Resume-friendly
easy diff
easy cleanup
```

Позже можно добавить:

```text
WorkspaceProvider
├── GitWorktree
└── OmpIsolation
```

но не раньше.

---

# Этап 20. Полная целевая архитектура

В итоге:

```text
┌─────────────────────────────────────────────────────────┐
│                       TaskBridge                        │
├─────────────────────────────────────────────────────────┤
│ Projects                                                │
│ Work Items                                              │
│ Sessions                                                │
│ Runs                                                    │
│ Resume                                                  │
├─────────────────────────────────────────────────────────┤
│ Context Broker                                          │
│ ├─ Project memory                                       │
│ ├─ Session recap                                        │
│ ├─ Git context                                          │
│ ├─ project-md                                           │
│ ├─ Code intelligence                                    │
│ └─ Artifacts                                            │
├─────────────────────────────────────────────────────────┤
│ Canonical Agent Protocol                                │
│ ├─ messages                                             │
│ ├─ tools                                                │
│ ├─ approvals                                            │
│ ├─ usage                                                │
│ └─ lifecycle                                            │
├─────────────────────────────────────────────────────────┤
│ Runtime adapters                                        │
│                                                         │
│  PiRuntime              OmpRuntime         Future       │
│     │                       │              Codex/...     │
├─────┴───────────────────────┴─────────────────────────────┤
│ Workspace                                               │
│ Git / worktrees                                         │
├─────────────────────────────────────────────────────────┤
│ Artifact / Blob Store                                   │
└─────────────────────────────────────────────────────────┘
```

---

# Конкретный roadmap

Я бы теперь официально заменил старый roadmap на такой:

| MR | Что делаем | Результат |
|---|---|---|
| **MR-01** | Project Dashboard | проект становится основной точкой входа |
| **MR-02** | Work Items | долговременные задачи проекта |
| **MR-03** | Work Item ↔ Sessions | несколько коротких сессий на одну задачу |
| **MR-04** | Resume Engine + Preview | новая чистая сессия продолжает старую работу |
| **MR-05** | Session Recap | вместо передачи длинных transcript |
| **MR-06** | Memory Provider + pi-memory-md analysis | canonical long-term memory |
| **MR-07** | Knowledge Inspector | видим, что проект реально помнит |
| **MR-08** | Controlled memory suggestions | знания сохраняются осознанно |
| **MR-09** | Context Broker + provenance | единая политика контекста |
| **MR-10** | selective project-md | файловый контекст по запросу |
| **MR-11** | AST/code search | быстрый semantic discovery |
| **MR-12** | Structural read + LSP | меньше токенов, умнее навигация |
| **MR-13** | AST edit preview/apply | безопасные структурные изменения |
| **MR-14** | Artifact spill | большие outputs перестают раздувать чат |
| **MR-15** | Canonical Runner/Event API | Pi перестаёт быть зашит в ядро |
| **MR-16** | OMP RPC spike | проверяем протокол независимо |
| **MR-17** | OMP runtime | Pi и OMP из одного TaskBridge |
| **MR-18** | OMP tools/capabilities | native AST/LSP/tools OMP |
| **MR-19** | Subagents + Reviewer UI | используем сильную сторону OMP |
| **MR-20** | Project Archive/Search | поиск Work/recap/memory |
| **MR-21** | Performance + cleanup | soak tests, migration, telemetry |

---

# Что НЕ делать

Это также часть архитектуры.

**Не добавлять:**

```text
TaskBridge Memory DB
+
pi-memory-md
+
OMP Mnemopi
```

Не делать три memory systems.

**Не делать:**

```text
project-md whole repo → every prompt
```

**Не делать:**

```text
OMP Session Tree = TaskBridge Work Item
```

Это разные уровни.

**Не делать:**

```text
OMP subagent = TaskBridge Session
```

не всегда.

**Не переносить сразу:**

```text
hashline
OMP isolation
OMP memory
OMP TUI
```

**Не писать:**

```js
if (runner === 'pi')
else if (runner === 'omp')
```

по всему проекту.

Только capabilities + adapters.

---

# Что даст пользователь в итоге

С телефона:

```text
TaskBridge
────────────────────────

TaskBridge project

In progress
  Improve project memory

Sessions
  Pi        Backend memory     ✓
  OMP       Code architecture  ●
  Reviewer  Review             !

Knowledge
  31 project facts

Context
  11.4k / 64k

[Continue task]
```

Нажимаешь **Continue task**:

```text
New clean session

Agent
● Pi
○ OMP

Workspace
● Fresh worktree
○ Existing worktree

Context
✓ Goal
✓ Acceptance
✓ Previous recap
✓ Project memory
✓ Git changes
✓ Relevant files

~9,200 tokens

[Start]
```

Через день можно выбрать OMP вместо Pi — **Work Item остаётся тот же**.

Именно это отличает хороший гибрид от Frankenstein:

> **TaskBridge владеет смыслом работы.  
> Pi/OMP владеют только выполнением конкретной сессии.**

---

## С чего начинать прямо сейчас

Не с OMP.

Текущая последовательность:

```text
закрыть Android history P0
        ↓
MR-01 Project Dashboard
        ↓
MR-02 Work Items
        ↓
MR-03 Work Item ↔ Sessions
        ↓
MR-04 Resume Engine
        ↓
MR-05 Session Recap
```



Да. Это не отдельная «фича в конце», а **четвёртый фундаментальный слой TaskBridge** наряду с памятью, runtime и workspace.

Причём хорошая новость: значительная часть инфраструктуры уже заложена. В репозитории уже есть `CloudTransport`, relay, протокол `client → WSS relay → WSS machine`, device tokens, `commandId`-идемпотентность и правило **ПК остаётся source of truth**. Поэтому строить всё заново не надо.

## Целевая архитектура с мобильным интернетом

```text
                         ┌───────────────────┐
                         │    Android App    │
                         │ Desktop / PWA     │
                         └─────────┬─────────┘
                                   │
                         Connection Manager
                       ┌───────────┴───────────┐
                       │                       │
                  LAN / Wi-Fi              Internet
                       │                       │
                  HTTP + SSE                  WSS
                       │                       │
                       │                Public Relay
                       │                       │
                       │                encrypted tunnel
                       │                       │
                       └───────────┬───────────┘
                                   │
                               TaskBridge PC
                                   │
                    ┌──────────────┼──────────────┐
                    │              │              │
                  Pi/OMP        Projects       Git/worktree
                    │
                 local LLM
```

Ключевой принцип:

> **Телефон никогда не подключается напрямую к Pi, OMP, llama.cpp или файловой системе.**  
> Он всегда работает только через TaskBridge API/Protocol.

---

# Что уже есть

В текущем коде уже заложена правильная модель.

В `src/cloud/protocol.mjs` прямо описано:

```text
client ── WSS ──► relay ── WSS ──► machine ──► Pi
```

Причём облако **не должно быть базой сессий** — source of truth остаётся домашний ПК.

Протокол уже предусматривает:

```text
HELLO
AUTH
MACHINE_STATUS

SESSION_LIST
ATTACH / DETACH
SYNC

COMMAND
COMMAND_ACK

REQUEST
RESPONSE

EVENT

PING / PONG
```

Это очень хороший фундамент.

Также уже есть критически важное для мобильного интернета:

```text
commandId
```

То есть если LTE оборвался после отправки команды:

```text
Phone → "Fix bug"
       ↓
сеть пропала
       ↓
телефон не знает, дошло или нет
```

повтор не должен запустить второй agent turn.

Существующий command ledger уже решает именно эту проблему.

---

# Новый архитектурный слой: Connectivity

Я бы добавил полноценный:

```text
ConnectionManager
```

который скрывает от приложения способ подключения.

## Интерфейс

Условно:

```kotlin
interface TaskBridgeTransport {
    val state: StateFlow<ConnectionState>

    suspend fun request(request: ApiRequest): ApiResponse

    fun events(sessionId: String): Flow<TaskEvent>

    suspend fun sendCommand(command: Command): CommandAck

    suspend fun sync(sessionId: String, afterSeq: Long)
}
```

Реализации:

```text
TaskBridgeTransport
├── LocalTransport
└── RelayTransport
```

UI вообще не знает, используется Wi-Fi или мобильный интернет.

---

# Automatic transport switching

На телефоне пользователь не должен выбирать:

```text
Wi-Fi
или
Cloud
```

вручную каждый раз.

ConnectionManager делает:

```text
           PC доступен напрямую?
                  │
             yes ─┴─ no
              │       │
           Local     Relay
```

Например:

```text
Wi-Fi дома
→ 192.168.1.100
→ LocalTransport

вышел из дома
→ Wi-Fi исчез
→ RelayTransport

вернулся домой
→ LAN снова доступен
→ LocalTransport
```

При этом открытая сессия должна продолжить работать.

---

# Важный принцип: Session identity не зависит от транспорта

Нельзя получить:

```text
LAN session
Cloud session
```

Это одна и та же:

```text
sessionId = abc123
```

Меняется только канал.

Поэтому:

```text
Session
Work Item
Run
Agent runtime
```

вообще не должны знать, как телефон подключён.

---

# MR-Remote-01 — довести Cloud Relay до production transport

Я бы поставил этот этап довольно рано — **после базовых Work Items/Session relations и до большого UI расширения**.

Проверяем и стабилизируем:

```text
PC → outbound WSS → relay
Phone → outbound WSS → relay
```

### Никаких

```text
port forwarding
UPnP
публичного localhost
открытого 8787 наружу
```

Это особенно хорошо для мобильного интернета и CGNAT.

---

# Relay должен быть тупым

Очень важное правило против Frankenstein:

```text
Relay НЕ знает:

Project
Work Item
Pi
OMP
Git
memory
workspace
```

Relay знает только:

```text
machineId
deviceId
frame
routing
queue
connection state
```

То есть:

```text
Relay = message switch
```

а не второй TaskBridge server.

---

# MR-Remote-02 — реальная E2EE

Вот это я считаю обязательным перед нормальным удалённым использованием.

Сейчас в протоколе уже заложена архитектура, что `payload` впоследствии становится ciphertext, но **не стоит считать это автоматически реализованным end-to-end encryption**.

Цель:

```text
Android                     PC
   │                         │
   ├──── encrypted payload ──┤
            ↑
          Relay
     не может читать
```

Relay видит только минимально необходимое:

```text
protocolVersion
machineId
routing metadata
frame type
ciphertext
```

Но не:

```text
prompt
code
diff
project name
tool output
memory
```

---

# Ключи

Я бы сделал:

```text
Machine identity key
        +
Device identity key
```

При pairing:

```text
PC
 ↓
one-time QR
 ↓
Phone
 ↓
key agreement
 ↓
trusted device
```

После pairing relay не получает master secret.

---

# Pairing

Текущая идея с QR хорошая.

UX:

```text
TaskBridge PC

Remote access
────────────────────
Status: Connected

[Pair new device]

        QR CODE
```

На Android:

```text
Scan TaskBridge QR
```

После этого:

```text
Device:
OnePlus A6013
Added: today
Last seen: 2 min ago
```

На ПК:

```text
Trusted devices

OnePlus A6013       online
Pixel emulator      offline

[Revoke]
```

И отзыв должен действовать немедленно.

---

# MR-Remote-03 — Durable Command Inbox

Это особенно важно именно для мобильной сети.

Мы это уже обсуждали применительно к батарее и reconnect.

Телефон не должен держать соединение идеально живым, чтобы команда дошла.

## Сценарий

```text
Phone
"Run tests"
    ↓
COMMAND id=xyz
    ↓
Relay
    ↓
PC offline
```

Команда становится:

```text
PENDING
```

ПК появляется:

```text
relay
 ↓
TaskBridge PC
 ↓
dedupe(commandId)
 ↓
execute exactly once
```

Телефон получает:

```text
ACCEPTED
DISPATCHING
COMPLETED
```

---

# UNKNOWN_AFTER_CRASH

Существующая концепция очень правильная.

После:

```text
команда дошла
↓
TaskBridge упал
↓
ACK не успел записаться
```

нельзя говорить телефону:

```text
"не дошло, повтори"
```

Иначе агент выполнит действие дважды.

Поэтому:

```text
UNKNOWN_AFTER_CRASH
```

остаётся first-class состоянием.

Клиент проверяет историю по `commandId`.

---

# MR-Remote-04 — Reliable Event Sync

Для мобильного интернета нельзя рассчитывать на постоянный WebSocket.

Android:

```text
LTE
 ↓
туннель
 ↓
лифт
 ↓
нет сети
 ↓
сеть появилась
```

Нужно:

```text
lastSeq = 851
```

после reconnect:

```text
SYNC(afterSeq=851)
```

ПК возвращает:

```text
852
853
...
914
```

а потом подключается live stream.

Это уже соответствует текущей модели событий TaskBridge.

---

# Не хранить историю в Relay

Даже для reconnect.

Canonical history:

```text
PC SQLite
```

Relay может иметь только ограниченный transport queue:

```text
commands waiting for PC
short transient event buffering
```

но не:

```text
полный chat
Work Items
memory
Git state
```

---

# MR-Remote-05 — Android connection state machine

Это отдельная важная часть.

Например:

```kotlin
sealed interface ConnectionState {
    data object Local : ConnectionState
    data object Relay : ConnectionState

    data object Connecting : ConnectionState
    data object Offline : ConnectionState

    data class Reconnecting(...) : ConnectionState
}
```

Более полно:

```text
DISCONNECTED
   ↓
DISCOVERING_LOCAL
   ├── found → LOCAL_CONNECTED
   │
   └── not found
           ↓
     CONNECTING_RELAY
           ↓
      RELAY_CONNECTED
```

При потере:

```text
RECONNECTING
```

---

# Battery-friendly Android

Это тоже надо учитывать.

Не надо:

```text
каждые 2 секунды polling
```

в фоне.

Используем:

```text
foreground:
    WebSocket

short background:
    socket if OS permits

deep background:
    disconnect / push wakeup

resume:
    SYNC(afterSeq)
```

Именно наличие надежного `SYNC` позволяет спокойно дать Android уснуть.

---

# MR-Remote-06 — Push notifications

Для полноценной работы вне дома это очень полезно.

Например:

```text
TaskBridge
Agent needs approval

Allow:
rm ...
```

или:

```text
Verification failed
```

Не нужно держать приложение открытым.

Схема:

```text
PC
 ↓
Relay/cloud notification service
 ↓
FCM
 ↓
Android
```

Но push содержит только:

```text
sessionId
event class
opaque notification id
```

Не исходный код и не prompt.

При нажатии приложение открывается и забирает реальное содержимое по защищённому каналу.

---

# MR-Remote-07 — Offline UI

Телефон должен нормально выглядеть без сети.

Например:

```text
Project Dashboard

Offline
Last sync: 18:42

TaskBridge
  Work Item A
  Session X
```

Можно читать локальный cache.

Команды:

```text
Message
Cancel
Approve
```

попадают в outbox.

Но здесь важно разделять безопасные команды.

---

# Не все команды можно бесконтрольно ставить в очередь

Например:

```text
"продолжай работу"
```

можно.

А:

```text
"Cancel"
```

через 20 минут может уже не иметь смысла.

Поэтому у команды:

```ts
Command {
    id
    type

    createdAt
    expiresAt?

    idempotencyKey

    stalePolicy
}
```

Например:

```text
MESSAGE:
    durable

STOP:
    short TTL

APPROVAL:
    expires with approval

RESTART:
    requires current state validation
```

---

# MR-Remote-08 — Large Artifact transfer

Очень хорошо сочетается с нашим будущим Artifact Store.

Нельзя через WebSocket пихать:

```text
12 MB log
8 MB screenshot
large diff
```

Протокол уже ограничивает размер frame.

Правильно:

```text
Android
  ↓
GET artifact metadata
  ↓
request blob
  ↓
streamed/chunked transfer
```

И наоборот для attachment:

```text
Phone photo/file
       ↓
upload
       ↓
ArtifactStore
       ↓
Agent receives reference
```

---

# Это отлично сочетается с OMP

Потому что OMP будет находиться **за ПК**, а не в интернете.

```text
Phone
   ↓
Relay
   ↓
TaskBridge
   ↓
AgentRuntime
   ├── Pi
   └── OMP
```

Телефон никогда не должен знать OMP RPC.

То есть:

```text
OMP RPC
```

остаётся:

```text
localhost
```

между TaskBridge и OMP.

---

# Remote Resume

Вот здесь память + мобильный доступ начинают работать вместе.

Ты находишься вне дома.

На Android:

```text
Project: TaskBridge
Work Item: Improve project memory

Previous sessions:
✓ Pi backend
✓ Pi tests

[Continue]
```

Выбираешь:

```text
Agent
○ Pi
● OMP

Workspace
● fresh worktree

Context
✓ Work Item
✓ recap
✓ project memory
✓ Git
✓ relevant files
```

Нажимаешь Start.

Дальше:

```text
Android
 ↓
encrypted Relay command
 ↓
TaskBridge PC
 ↓
revalidate
 ↓
create worktree
 ↓
ContextBroker
 ↓
start OMP
```

И всё это можно делать через мобильный интернет.

---

# Remote Project Memory

То же относится к Knowledge Inspector.

С телефона можно:

```text
Project → Knowledge
```

искать:

```text
"как работает worktree?"
```

Но поиск выполняется:

```text
Phone
 ↓
TaskBridge PC
 ↓
pi-memory-md
```

а не в облачной копии memory.

То есть конфиденциальная project memory остаётся дома.

---

# Remote AST/Search

Аналогично:

```text
Phone
"Где вызывается loadOlder?"
```

TaskBridge на ПК:

```text
CodeIntelligenceProvider
 ↓
AST/LSP
 ↓
compact result
```

На телефон отправляется только результат.

Это особенно рационально: телефон становится **тонким remote IDE/controller**, а тяжёлая работа остаётся на Ryzen/5070 Ti.

---

# Обновлённый roadmap

Я бы теперь разбил его так:

| MR | Этап |
|---|---|
| **01** | Project Dashboard |
| **02** | Work Items |
| **03** | Work Item ↔ Sessions |
| **04** | Resume Engine |
| **05** | Session Recap |
| **06** | Memory Provider / pi-memory-md |
| **07** | Knowledge Inspector |
| **08** | Memory Suggestions |
| **09** | Context Broker |
| **10** | selective project-md |
| **11** | AST search |
| **12** | Structural Read + LSP |
| **13** | AST Edit |
| **14** | Artifact Store / spill |
| **15** | **Unified Transport API** |
| **16** | **Android Local ↔ Relay switching** |
| **17** | **Relay hardening + durable commands** |
| **18** | **E2EE + trusted devices** |
| **19** | **Offline sync + push + artifact transfer** |
| **20** | Canonical Agent Runtime API |
| **21** | OMP RPC spike |
| **22** | OMP Runtime |
| **23** | OMP native capabilities |
| **24** | Subagents / Reviewer |
| **25** | Project Archive/Search |
| **26** | Performance/soak/cleanup |

Но я бы **не ждал MR-15, чтобы помнить о remote compatibility**.

С MR-01 каждый новый API должен удовлетворять правилу:

> **Если операция работает локально, она должна быть транспортабельна через Relay без отдельной бизнес-логики.**

То есть уже Work Items, Resume, Knowledge Inspector должны проектироваться transport-neutral.

---

# Что в итоге получаем

Получается уже действительно сильная система:

```text
                   TaskBridge
                       │
       ┌───────────────┼───────────────────┐
       │               │                   │
   Project Brain    Agent Control       Connectivity
       │               │                   │
 Work Items          Pi / OMP          LAN / Internet
 Memory              Reviews             Relay
 Resume              Subagents           E2EE
 Context             Tools               Offline
       │               │                   │
       └───────────────┼───────────────────┘
                       │
                  Home workstation
                       │
             Git + files + local LLM
```

И это уже не «приложение для запуска Pi».

Это становится **удалённой персональной development workstation/control plane**: с телефона через мобильный интернет можно выбрать проект, увидеть память и текущую работу, продолжить Work Item чистой сессией, выбрать Pi/OMP, следить за агентом, подтверждать действия, смотреть diff/tests и получать уведомление о завершении — при этом код, история, память и модели остаются на домашнем ПК.




Да. Это хорошо ложится в архитектуру TaskBridge и, более того, усиливает Work Item/Resume концепцию.

Я бы добавил не просто «cron для отправки сообщения», а отдельный слой **Recurring Work / Run Recipes**: пользователь один раз описывает, *что* нужно делать, *с какими параметрами*, *каким агентом*, *в каком workspace* и *с каким контекстом*, а TaskBridge периодически создаёт новые управляемые запуски.

## Как это должно выглядеть концептуально

```text
Project
└── Work Item
    ├── Sessions
    ├── Recap
    ├── Memory
    │
    └── Run Recipe
         ├── prompt template
         ├── parameters
         ├── runtime
         ├── model/thinking
         ├── context policy
         ├── workspace policy
         ├── verification policy
         └── Schedule
               ↓
           Invocation #1
           Invocation #2
           Invocation #3
```

То есть мы **не переиспользуем бесконечно один чат**. По умолчанию каждое периодическое выполнение создаёт короткую новую сессию внутри того же Work Item.

Это важно для памяти и стабильности.

---

# Пример

Допустим, задача:

> Раз в сутки проверить TaskBridge на свежие ошибки и сделать небольшой аудит.

В UI:

```text
Recurring task
────────────────────────────

Name
Daily TaskBridge audit

Prompt
Проверь проект на новые проблемы после {{base_ref}}.
Особое внимание: {{area}}.
Запусти {{test_suite}}.

Parameters
base_ref       = master
area           = Android + server
test_suite     = smoke

Agent
OMP

Model
Qwen local

Context
Work Item + project memory + Git diff

Workspace
Fresh worktree from {{base_ref}}

Verification
Required

Schedule
Every day at 09:00

On success
Keep report, remove clean worktree

On changes
Keep worktree + notify me

[Run now] [Save schedule]
```

---

# Главное: разделить Recipe, Schedule и Invocation

Не стоит создавать сущность `scheduled_task`, которая содержит всё подряд.

Лучше:

```text
RunRecipe
    = КАК выполнить работу

Schedule
    = КОГДА запускать

Invocation
    = конкретный факт запуска
```

Это позволит одну и ту же recipe запускать:

```text
вручную
по расписанию
с телефона
через API
позже — событием Git
```

без дублирования логики.

---

# `RunRecipe`

Предлагаю примерно такой контракт:

```json
{
  "id": "recipe-daily-audit",
  "projectId": "taskbridge",
  "workItemId": "wi-maintenance",

  "name": "Daily TaskBridge audit",

  "promptTemplate": "Проверь {{area}} относительно {{base_ref}}...",

  "runtime": {
    "id": "omp",
    "model": "qwen-local",
    "thinking": "medium"
  },

  "context": {
    "profile": "work-item",
    "includeMemory": true,
    "includeRecap": true,
    "includeGit": true
  },

  "workspace": {
    "strategy": "fresh-worktree",
    "baseRef": "{{base_ref}}"
  },

  "verification": {
    "required": true
  },

  "limits": {
    "timeoutMinutes": 60
  }
}
```

Recipe не содержит состояние конкретного запуска.

---

# Параметры

Это особенно полезная часть твоей идеи.

У recipe должна быть схема параметров:

```json
{
  "parameters": {
    "base_ref": {
      "type": "string",
      "default": "master"
    },
    "area": {
      "type": "enum",
      "values": [
        "all",
        "android",
        "server",
        "web"
      ],
      "default": "all"
    },
    "run_tests": {
      "type": "boolean",
      "default": true
    }
  }
}
```

На телефоне тогда можно нажать:

```text
Run again

area
[ Android ▼ ]

base_ref
[ master ]

run_tests
[✓]

[Run]
```

Это намного удобнее, чем редактировать огромный prompt вручную.

---

# Параметры не должны ограничиваться prompt

Очень важно.

`{{parameter}}` должен уметь влиять не только на текст:

```text
prompt
model
thinking
Git base
workspace strategy
verification command
context profile
runtime
```

Например:

```text
Agent:
{{runtime}}

Branch:
{{base_ref}}

Verification:
{{verification_profile}}
```

Но разрешать substitution только в заранее разрешённых полях, а не произвольной shell-команде.

---

# Повтор запуска прямо из чата

В каждом выполнении я бы сделал кнопку:

```text
⋮
├── Run again
├── Run again with parameters
├── Save as recipe
└── Schedule…
```

Это очень хороший UX.

Например завершился чат:

```text
Android regression audit
✓ Done
17 min

[Run again]
```

Нажал — появляется:

```text
Run again

Agent         OMP
Area          Android
Base          master
Tests         smoke
Context       Fresh

[Start]
```

То есть обычная Session может постепенно превратиться в reusable recipe.

---

# Что именно значит `Run again`

Есть важное архитектурное решение.

Не делать:

```text
открыть старую Session
→ ещё раз послать тот же prompt
```

По умолчанию лучше:

```text
RunRecipe
      ↓
новый ResumeContext
      ↓
новый workspace
      ↓
новая Session
```

Тогда результаты каждого запуска независимы.

Получаем:

```text
Work Item: Daily regression check

2026-10-10  ✓
2026-10-11  ✓
2026-10-12  ! 2 regressions
2026-10-13  ✓
```

Это гораздо полезнее одной бесконечной Session.

---

# Но режим продолжения тоже можно оставить

Recipe:

```text
sessionPolicy:
    fresh
```

или:

```text
sessionPolicy:
    continue
```

Я бы сделал **`fresh` default**.

`continue` подходит только для специфических сценариев:

```text
каждые 30 минут продолжай один research task
```

Но он постепенно раздувает context.

---

# Интеграция с нашей памятью

Здесь архитектура начинает особенно хорошо складываться.

При каждом запуске:

```text
Run Recipe
     ↓
Context Broker
     ├── current Work Item
     ├── latest Recap
     ├── project memory
     ├── current Git state
     ├── relevant files
     └── run parameters
           ↓
      new Session
```

То есть расписание **не сохраняет snapshot контекста**.

Оно сохраняет только правила:

```text
что включить
```

А реальный context собирается непосредственно перед выполнением.

Это означает, что ежедневный запуск будет знать состояние проекта **на сегодня**, а не контекст месячной давности.

---

# Scheduler должен работать на ПК

Это тоже принципиально.

```text
Android ──► TaskBridge PC Scheduler
```

А не:

```text
Android background alarm
```

и не:

```text
Relay выполняет работу
```

Source of truth снова домашний TaskBridge.

Даже если телефон выключен:

```text
09:00
TaskBridge PC
   ↓
scheduler
   ↓
new invocation
   ↓
OMP/Pi
```

Телефон потом получает результат.

---

# А если ПК был выключен?

Нужна `misfirePolicy`.

Например:

```text
SKIP
```

Пропустить запуск.

```text
RUN_ONCE
```

ПК включился в 12:00 — выполнить один пропущенный запуск.

```text
CATCH_UP
```

Выполнить все пропущенные.

Для coding-agent задач `CATCH_UP` почти всегда опасен.

Default:

```text
RUN_ONCE
```

Например ПК был выключен три дня — не надо запускать три независимых аудита подряд.

---

# Concurrency policy

Тоже обязательная часть.

Допустим ежедневный аудит ещё работает, а пришло время следующего.

Нельзя случайно запустить:

```text
Audit #18
Audit #19
```

в одном workspace.

Нужны политики:

```text
SKIP_IF_RUNNING
QUEUE
PARALLEL
REPLACE
```

Default:

```text
SKIP_IF_RUNNING
```

или `QUEUE` для безопасных задач.

`PARALLEL` допустим только с независимыми worktrees.

---

# Git/workspace policy

Recipe должен явно задавать:

```text
fresh-worktree
reuse-worktree
read-only
```

Для периодических jobs default:

```text
fresh-worktree
```

Например:

```text
master
  ↓
worktree scheduled/2026-10-11
  ↓
agent
```

После выполнения:

```text
нет изменений
→ удалить worktree

есть изменения
→ сохранить
→ показать пользователю diff
```

---

# Нельзя автоматически merge'ить изменения

По умолчанию:

```text
Agent produced changes
        ↓
Verification
        ↓
TaskBridge notification
        ↓
user review
```

Не:

```text
agent → commit → merge master
```

Автоматический merge можно когда-нибудь добавить отдельной policy, но не в MVP.

---

# Verification profiles

Recipe можно дать:

```text
verificationProfile = "android-smoke"
```

А Project знает:

```yaml
android-smoke:
  - :client:jvmTest
  - :shared:jvmTest

server-full:
  - npm test
```

Так prompt не содержит shell-команды.

Это безопаснее и удобнее.

---

# Результат каждого Invocation

Отдельная запись:

```json
{
  "id": "inv-128",
  "recipeId": "recipe-daily-audit",

  "scheduledAt": "...",
  "startedAt": "...",
  "finishedAt": "...",

  "parameters": {
    "area": "android"
  },

  "sessionId": "session-xyz",

  "status": "SUCCEEDED",

  "verification": "PASSED",

  "workspaceRef": "...",

  "resultArtifact": "..."
}
```

То есть появляется нормальная история:

```text
Daily Android check
────────────────────────

Today          ✓
Yesterday      ✓
Oct 9          ! regression
Oct 8          ✓
```

---

# Отдельный `scheduled_runs` не нужен

У нас уже есть `runs`.

Но важно не смешать уровни.

Я бы добавил:

```text
recipes
schedules
invocations
```

А существующий `runs` остаётся execution history внутри Session.

```text
Schedule
  ↓
Invocation
  ↓
Session
  ↓
Run(s)
```

Например одна Invocation может создать Session, которая внутри выполнит несколько Run.

---

# Notification policy

Особенно полезно с мобильным интернетом.

Например:

```text
Notify
● only if action required
○ always
○ errors only
○ never
```

События:

```text
regression found
verification failed
approval required
agent failed
changes produced
finished successfully
```

Так TaskBridge может ночью выполнить maintenance job и утром показать только:

> Android audit: 2 regressions found.

---

# Approvals в scheduled mode

Это сложный момент.

Если ночью агент хочет:

```text
rm something
```

что делать?

Policy:

```text
approvalMode:
    pause
```

TaskBridge переводит Invocation:

```text
WAITING_FOR_APPROVAL
```

Телефон получает push:

```text
OMP needs approval
```

Пользователь подтверждает.

Не давать scheduled tasks автоматически обходить существующую approval policy.

---

# Secrets / параметры

Параметры типа:

```text
API_KEY
token
password
```

не должны храниться прямо в recipe.

Нужен:

```text
secretRef
```

условно:

```json
{
  "github_token": {
    "type": "secret",
    "ref": "secret:github-main"
  }
}
```

Сам secret хранится отдельно и никогда не отображается в Resume/Recap/History.

---

# Что получится в UI

На Project Dashboard:

```text
TaskBridge
────────────────────────

Recurring work

Daily regression audit
Every day 09:00
Last: ✓ 18 min ago
Next: tomorrow 09:00

Model benchmark
Every Sunday
Last: ✓

Dependency audit
Paused
```

Карточка:

```text
Daily regression audit

Agent      OMP
Workspace  Fresh worktree
Context    Work Item + Memory
Verify     android-smoke

Last       ✓
Next       14h

[Run now]
[Parameters]
[Edit]
[Pause]
```

---

# Хорошо сочетается с OMP

Можно сделать Recipe:

```text
runtime = omp
```

для сложного автономного анализа.

И:

```text
runtime = pi
```

для лёгких задач.

Например:

```text
Daily:
Pi + local Qwen
→ быстрый cheap health check

Weekly:
OMP + stronger model
→ full architecture review
```

TaskBridge управляет расписанием, а runtime — только выполняет.

---

# Я бы добавил ещё Event Triggers

Не обязательно в первом релизе, но архитектуру сразу сделать готовой.

Сегодня:

```text
ScheduleTrigger
```

Позже:

```text
GitTrigger
FileTrigger
WebhookTrigger
ModelTrigger
ManualTrigger
```

Например:

```text
when master changes
    → run regression audit
```

или:

```text
when verification fails
    → start reviewer session
```

или:

```text
when local model becomes available
    → resume queued Work Item
```

Тогда `Schedule` лучше обобщить до:

```text
Trigger
```

---

# Новый roadmap

Я бы встроил это **после Resume Engine**, потому что recurring jobs напрямую используют Work Items + Resume.

```text
MR-01  Project Dashboard
MR-02  Work Items
MR-03  Work Item ↔ Sessions
MR-04  Resume Engine

MR-05  Run Recipes
MR-06  Scheduler + Invocation history
MR-07  Parameterized rerun from chat
MR-08  Session Recap

MR-09  Memory Provider
MR-10  Knowledge Inspector
MR-11  Memory Suggestions
MR-12  Context Broker
MR-13  project-md
MR-14  AST/Search
MR-15  Structural Read/LSP
MR-16  AST Edit
MR-17  Artifact Spill

MR-18  Unified Transport
MR-19  Relay/mobile connectivity
MR-20  Durable remote commands
MR-21  E2EE/offline/push

MR-22  Canonical Agent Runtime
MR-23  OMP RPC spike
MR-24  OMP Runtime
MR-25  OMP capabilities/subagents
MR-26  Reviewer workflow
MR-27  Archive/Search
```

И это логичный порядок.

---

## В итоге TaskBridge начинает становиться значительно интереснее

Мы получаем не просто:

```text
remote chat with Pi
```

а:

```text
Project
   │
   ├── Memory
   ├── Work Items
   ├── Recurring Jobs
   ├── Sessions
   ├── Reviews
   └── Artifacts
          │
       Context Broker
          │
    ┌─────┴─────┐
    Pi          OMP
```

Причём пользоваться этим можно с телефона через мобильный интернет.

Например ты вечером задаёшь с телефона:

> «Сохрани этот Android-аудит как повторяемую задачу, запуск каждый день в 09:00, `area=android`, только уведомляй при регрессии».

А дальше TaskBridge сам создаёт чистые сессии, подтягивает актуальную память проекта, текущий Git, запускает выбранного агента, проверяет результат и показывает историю запусков.

Это я бы однозначно добавил в целевую архитектуру.



После **MR-05** TaskBridge уже получит принципиально новую «память проекта»: можно будет месяцами вести один Work Item через десятки коротких Pi-сессий без переноса огромных контекстов.

Затем строим `MemoryProvider → ContextBroker → Code Intelligence → ArtifactStore`, и **только когда эти абстракции стабильны, подключаем OMP**.

Это важный порядок: тогда OMP добавляется примерно как новый драйвер, а не заставляет переписывать TaskBridge под себя.

И дополнительный плюс: существующий `src/runners/pi-runner.mjs` уже задуман как capability-aware abstraction для будущих runner'ов. Значит MR-15 — не архитектурный разворот, а завершение направления, которое в TaskBridge уже начато. [текущий PiRunner в TaskBridge](https://github.com/arnyigor/TaskBridge/blob/master/src/runners/pi-runner.mjs?utm_source=chatgpt.com)

Если следовать этому плану, конечный продукт действительно выглядит цельным: **память и workflow от TaskBridge, быстрый и компактный контекст от Context Broker, Git как источник истины, Pi как лёгкий универсальный runtime и OMP как более мощный coding runtime с AST/LSP/subagents.**