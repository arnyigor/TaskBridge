Да. Для такого объёма изменений нужен не набор случайных тестов, а **единый regression contract TaskBridge**. Иначе после MR-10 мы уже не поймём, сломал ли новый Context Broker старый Pi, Relay, Android history или worktree.

Я бы зафиксировал следующий план как обязательный `TESTING_PLAN.md`.

# 1. Главный принцип

После каждого MR проверяем две вещи:

1. **Новая функция работает.**
2. **Старые гарантии TaskBridge остались неизменными.**

То есть тестирование:

```text
Feature tests
      +
Regression tests
      +
Integration tests
      +
E2E smoke
```

Для крупных изменений:

```text
+ Failure tests
+ Performance
+ Soak
```

---

# 2. Сначала зафиксировать baseline

До серьёзной переработки снять состояние текущего `master`.

Нужно сохранить:

```text
commit SHA
Node version
Java version
Android emulator/device
Pi version
OMP version — позже
```

И результаты:

```bash
npm run check
npm test
npm run test:cloud
npm run stress
npm run smoke:pi
```

KMP:

```bash
cd clients/kmp

./gradlew :core:client:jvmTest
./gradlew :shared:jvmTest
./gradlew :androidApp:assembleDebug
./gradlew :desktopApp:compileKotlinJvm
```

Плюс:

```bash
git diff --check
```

Если baseline уже имеет известный failing test, он фиксируется отдельно:

```text
KNOWN_BASELINE_FAILURES.md
```

Нельзя позволять агенту говорить:

> «npm test падает, но наверное это было раньше».

Должно быть объективно известно.

---

# 3. Постоянный Core Regression Suite

Это набор, который должен проходить **после каждого MR независимо от области изменений**.

## Server

Обязательно:

```text
✓ запуск TaskBridge
✓ загрузка существующей SQLite
✓ создание Session
✓ отправка первого prompt
✓ follow-up
✓ queue message
✓ steering
✓ cancel
✓ restart session
✓ compact
✓ model switch
✓ thinking switch
✓ завершение Session
✓ повторное открытие Session
```

## Chat

```text
✓ начальная история
✓ live SSE
✓ reconnect
✓ gap recovery
✓ old-history pagination
✓ reachedStart
✓ большие ответы
✓ thinking
✓ tools
✓ tool result
✓ partial turn
✓ edit
✓ delete
✓ regenerate
✓ fork
✓ variants
✓ TURN_TRUNCATED
✓ TURN_EDITED
```

## Git

```text
✓ clean workspace
✓ dirty workspace
✓ worktree creation
✓ worktree removal
✓ diff
✓ staged files
✓ untracked files
✓ binary file
✓ truncated diff
✓ verification
```

## Files

```text
✓ attachment upload
✓ text file
✓ image
✓ missing file
✓ deleted file
✓ duplicate filename
✓ large file
```

## Auth

```text
✓ pairing
✓ bearer token
✓ revoked token
✓ invalid token
✓ expired/rejected device
✓ forbidden Origin
```

Это и есть минимальная страховочная сетка проекта.

---

# 4. Golden Chat Fixtures

У TaskBridge уже правильное направление: KMP `ChatReducer` сверяется с web-chat fixtures.

Это нужно усилить.

Создать небольшой canonical corpus:

```text
tests/fixtures/chat/
```

Например:

```text
01-simple
02-thinking
03-tool-call
04-large-tool-output
05-steering
06-edit
07-delete
08-regenerate
09-fork
10-turn-truncated
11-partial-page
12-disconnect-mid-stream
13-reconnect
14-duplicate-event
15-out-of-order-event
16-long-session
```

Для каждого fixture хранить:

```text
events.json
expected-chat.json
```

И прогонять через:

```text
Web ChatReducer
KMP ChatReducer
позже canonical AgentEvent reducer
```

Результат должен быть семантически одинаковым.

Это особенно важно перед OMP.

---

# 5. Не проверять текст LLM как golden output

Например плохой тест:

```text
ожидаем:
"Исправил ошибку в ChatScreen.kt"
```

Модель может сформулировать иначе.

Проверять:

```text
создан ожидаемый файл
diff содержит нужное изменение
компиляция проходит
тест проходит
agent завершился
```

Для LLM:

> **Verification важнее текста ответа.**

---

# 6. History regression — отдельный обязательный suite

После недавнего Android P0 я бы навсегда оставил отдельный `ChatHistoryPagingTest`.

Проверить:

```text
1 страница
3 страницы
12 страниц
>12 страниц
пустая промежуточная страница
повтор одной страницы сервером
страница без визуального Turn
page cut внутри assistant turn
огромный tool output
reachedStart
```

Обязательные утверждения:

```text
oldestSeq строго уменьшается

одна страница не применяется дважды

один ChatItem.id не появляется дважды

нет бесконечного запроса

reachedStart останавливает загрузку

live tail не повреждается

TURN_TRUNCATED продолжает работать
```

И отдельно:

```text
scroll вверх
→ автоматическая загрузка
→ позиция не прыгает
→ LazyColumn не падает
```

---

# 7. Android regression suite

Не ограничиваться JVM tests.

После значимых UI/data изменений проверять реальный Android.

## Smoke

```text
запуск
connect
sessions
chat
отправка сообщения
live response
scroll
background
foreground
reconnect
```

## Chat

```text
long history
markdown
code block
table
thinking
tool block
expanded tool output
attachments
approvals
```

## Lifecycle

Особенно важно:

```text
open chat
→ Home
→ 30 sec
→ return
```

и:

```text
open chat
→ выключить экран
→ включить
```

и:

```text
rotate / configuration recreation
```

если применимо.

---

# 8. Android crash acceptance

После любого изменения history/reducer/cache:

```powershell
adb logcat -c
```

пройти сценарий и затем:

```powershell
adb logcat -d -b crash
```

Не должно быть:

```text
FATAL EXCEPTION
OutOfMemoryError
IllegalArgumentException duplicate key
LazyList crash
```

---

# 9. Memory/performance regression

Особенно для сессии ~19k events.

Три точки:

```text
A — session just opened
B — loaded ~50%
C — reached history start
```

Снять:

```bash
adb shell dumpsys meminfo <package>
```

Плюс внутренние метрики:

```text
loaded events
ChatReducer turns
ChatItems
text chars
tool count
cache bytes
snapshot duration
```

Следить за:

```text
heap growth
GC frequency
scroll jank
time to first screen
time to load history
```

Нужно сохранить baseline.

Например:

```text
AndroidLongHistoryBenchmark.json
```

После MR можно автоматически сравнивать:

```text
memory +8%         OK
memory +45%        regression
load 1.1s → 4.7s   regression
```

Не обязательно сразу вводить жёсткие проценты; сначала собрать стабильный baseline.

---

# 10. Work Items regression

Когда появится MR-02/MR-03:

Проверяем:

```text
create
rename
change status
set priority
acceptance criteria
delete/archive
```

Relations:

```text
WorkItem A
 ├ Session 1
 └ Session 2
```

Должны сохраняться после рестарта.

Особенно:

```text
удаление Session
≠ удаление Work Item
```

и:

```text
удаление Project registration
≠ потеря Session history
```

Это нужно явно тестировать.

---

# 11. Resume Engine regression

Это одна из наиболее рискованных частей.

Обязательные сценарии:

### Clean repository

```text
Session A
→ finish
→ Resume Preview
→ fresh worktree
→ Session B
```

Проверяем:

```text
same Work Item
different Session
correct HEAD
correct workspace
```

### Dirty repository

```text
modified
untracked
staged
```

Resume должен явно показывать состояние.

### Deleted worktree

```text
preview
→ удалить worktree
→ Launch
```

Ожидается:

```text
revalidation failure
```

Не:

```text
fallback to main checkout
```

Это должно быть жёстким regression test.

---

# 12. Resume Preview/Launch race

Очень важный тест.

```text
Preview HEAD=A

между Preview и Start:
git commit → HEAD=B
```

Start должен обнаружить изменение.

То же для:

```text
artifact deleted
worktree removed
memory provider changed
selected file changed
```

Никакой silent continuation.

---

# 13. Context Broker tests

Для заданного input должен строиться детерминированный ContextBundle.

Проверяем:

```text
token budget
priority
deduplication
truncation
provenance
freshness
```

Например:

```text
Memory говорит:
API uses v1

текущий файл говорит:
API uses v2
```

Текущий repository state должен иметь более высокий приоритет.

---

# 14. Context-budget regression

Обязательно synthetic tests:

```text
small project
medium project
huge project
```

Например context budget:

```text
16k
32k
64k
128k
```

Assert:

```text
never exceeds configured limit

mandatory Work Item retained

important Git state retained

low priority file context trimmed first
```

---

# 15. Memory regression

Для `pi-memory-md` / будущего MemoryProvider:

Проверяем:

```text
provider unavailable
empty memory
one result
many results
duplicate result
stale result
malformed result
```

TaskBridge не должен падать.

Также:

```text
MemoryProvider down
```

не должен блокировать обычную Session.

Поведение:

```text
warning + continue
```

если memory optional.

---

# 16. Memory Suggestions

Проверки безопасности:

```text
suggestion generated
→ НЕ записана автоматически
```

Только:

```text
user confirms
→ write
```

Также:

```text
Cancel
→ nothing written
```

и:

```text
provider write failure
→ UI показывает ошибку
→ suggestion не помечается saved
```

---

# 17. `project-md` regression

Основная опасность — случайно начать передавать огромный проект.

Проверить:

```text
specific selected file
multiple selected files
missing file
outside project
huge file
binary file
symlink
```

Обязательный assert:

```text
Context Broker никогда автоматически не вызывает
whole-project dump без policy.
```

---

# 18. AST/Search tests

Для Code Intelligence сделать фиксированный mini-repo.

Например:

```text
Foo.kt
Bar.kt
FooTest.kt
```

Проверить:

```text
definition
references
class
function
call sites
inheritance
exact string
filename
```

Очень важно отдельно доказать fallback:

```text
AST unavailable
→ text grep works
```

То есть OMP/native tooling не должен стать single point of failure.

---

# 19. AST Edit tests

Три уровня:

```text
preview
apply
verify
```

Тесты:

```text
correct match
0 matches
2 unexpected matches
file changed after preview
syntax error after edit
```

Самый важный:

```text
Preview hash = A

другой процесс изменил файл

Apply
```

Ожидаем:

```text
STALE_EDIT
```

а не повреждение нового файла.

---

# 20. Artifact spill regression

Создать tool outputs:

```text
1 KB
31 KB
32 KB
64 KB
256 KB
2 MB
20 MB
```

Проверить policy.

Например:

```text
small → inline
large → preview + artifact
```

Обязательно:

```text
full artifact byte-identical original
sha256 matches
```

UI:

```text
preview открывается
full result открывается по запросу
```

---

# 21. Artifact security

Проверить:

```text
../
absolute path
symlink escape
wrong session artifact
wrong device
deleted artifact
```

Клиент не должен получить файл вне разрешённого ArtifactStore.

---

# 22. Scheduler / Recurring Jobs

Это отдельный серьёзный regression suite.

Проверяем:

```text
Run now
scheduled run
parameter override
default parameters
invalid parameter
disabled schedule
paused recipe
```

Также:

```text
timezone
DST
server restart
```

---

# 23. Scheduler misfire

Для:

```text
SKIP
RUN_ONCE
CATCH_UP
```

нужны deterministic tests с fake clock.

Не использовать реальные ожидания в тестах.

Например:

```text
09:00 scheduled

PC offline until 12:00
```

Для `RUN_ONCE`:

```text
ровно 1 Invocation
```

не три и не ноль.

---

# 24. Scheduler concurrency

Для:

```text
SKIP_IF_RUNNING
QUEUE
PARALLEL
REPLACE
```

обязательные tests.

Особенно:

```text
parallel + reuse same worktree
```

должно быть запрещено или явно сериализовано.

---

# 25. Parameterized rerun

Нужно проверить, что:

```text
Run again
```

не мутирует исходную Session.

Например:

```text
Session A
→ Run again area=android
→ Session B
```

Assert:

```text
A untouched
B receives new params
same Work Item
new Invocation
```

---

# 26. Recipe determinism

Recipe должен хранить:

```text
template
schema
policy
```

а не snapshot актуального ContextBundle.

Regression test:

```text
recipe saved at commit A
repo moved to B
run recipe
```

Context должен быть построен относительно B, если именно это задаёт policy.

---

# 27. Local network regression

Existing direct mode должен проходить всегда.

Проверить:

```text
localhost
Wi-Fi LAN
private 10/8
172.16/12
192.168/16
```

Нельзя допустить:

> «после добавления Relay LAN стал работать только через облако».

Local path должен оставаться самым прямым.

---

# 28. Relay regression

Test topology:

```text
Client
 ↓
Relay
 ↓
TaskBridge
```

Проверять:

```text
HELLO
AUTH
SESSION_LIST
ATTACH
SYNC
REQUEST
RESPONSE
COMMAND
ACK
EVENT
PING/PONG
```

Для каждого frame type:

```text
valid
invalid
oversized
unknown protocol version
malformed JSON
```

---

# 29. Mobile network chaos tests

Это чрезвычайно важно.

Во время active Session:

```text
LTE connected
→ disconnect
→ reconnect
```

и:

```text
Wi-Fi
→ LTE
```

и:

```text
LTE
→ Wi-Fi
```

и:

```text
Airplane mode
→ restore
```

После этого:

```text
нет потерянных events
нет duplicate messages
нет duplicate command
chat reaches current state
```

---

# 30. commandId exactly-once tests

Это один из наиболее критичных контрактов TaskBridge.

Сценарий:

```text
client sends command ABC
server executes
ACK lost
client retries ABC
```

Assert:

```text
command executed exactly once
```

Другой:

```text
same commandId
different body
```

Assert:

```text
CONFLICT
```

---

# 31. UNKNOWN_AFTER_CRASH

Симулировать:

```text
command accepted
→ execution begins
→ process crashes before result persisted
```

После restart:

```text
UNKNOWN_AFTER_CRASH
```

Клиент не должен автоматически повторить потенциально выполненную команду.

---

# 32. Offline outbox

Проверить:

```text
offline
→ send 3 messages
→ reconnect
```

Должно быть:

```text
3 commands
correct order
exactly once
```

Но для `STOP`/approval проверять TTL/staleness.

---

# 33. E2EE regression

Когда появится E2EE:

Relay test должен буквально доказать:

```text
relay receives ciphertext
```

и не содержит:

```text
prompt text
file contents
memory
Git diff
```

Проверить rotation/revoke:

```text
device revoked
→ existing connection loses privileges
```

---

# 34. OMP adapter contract tests

До запуска настоящего OMP создать recorded RPC fixtures.

Например:

```text
startup
simple prompt
thinking
tool call
tool result
approval
cancel
error
exit
resume
```

Каждый OMP frame преобразуется:

```text
OMP frame
→ OmpEventAdapter
→ AgentEvent
```

И тестируем только canonical результат.

---

# 35. Pi adapter regression

Одновременно сделать тот же suite для Pi:

```text
Pi frame
→ PiEventAdapter
→ AgentEvent
```

Это ключевой migration test.

После перехода на canonical events результат старого Pi-чата должен остаться тем же.

---

# 36. Canonical AgentEvent parity

Для эквивалентного сценария:

```text
Pi
```

и:

```text
OMP
```

должны выдавать одинаковую семантику:

```text
UserMessage
AssistantStarted
AssistantDelta
ToolStarted
ToolFinished
AssistantFinished
AgentSettled
```

Не обязательно одинаковое количество raw events.

---

# 37. Capability tests

Нельзя доверять UI вручную.

Например:

```text
runner.can("compact") == false
```

Assert:

```text
button hidden/disabled
API rejects unsupported action predictably
```

То же:

```text
steer
thinking
modelSwitch
subagents
structuralEdit
```

---

# 38. Pi fallback test

Когда OMP станет default, всё равно обязательно:

```text
OMP executable missing
```

Проверяем два сценария.

Если выбран:

```text
runtime=OMP explicitly
```

→ понятная ошибка.

Если policy:

```text
runtime=AUTO
```

→ допустимый fallback Pi.

Никакого скрытого fallback, если пользователь явно выбрал OMP.

---

# 39. OMP/Pi A/B benchmark

Перед решением сделать OMP default собрать representative suite.

Например:

```text
simple bug
cross-file bug
Kotlin refactoring
JS backend change
test failure diagnosis
large repo navigation
Git inspection
review-only task
```

Одинаково:

```text
same commit
same model
same prompt
same worktree state
same verification
```

Метрики:

```text
time-to-first-action
time-to-verified-solution
tool calls
bytes read
tokens
verification pass
retries
agent failure
```

---

# 40. Runtime switch regression

Сценарий:

```text
Work Item
 ├ Pi Session
 └ OMP Session
```

Resume OMP после Pi должен получать:

```text
Work Item
recap
Git
memory
```

а не Pi-specific session internals.

И наоборот.

Это один из лучших тестов правильности архитектуры.

---

# 41. Database migrations

Каждый schema MR должен иметь минимум три tests:

```text
fresh DB
previous-version DB
current DB restart
```

И отдельно:

```text
migration interrupted
```

где это возможно.

Нельзя тестировать только чистую новую SQLite.

---

# 42. Existing data regression

Подготовить anonymized fixture старого `taskbridge.db`.

Например версии:

```text
v0.10
v0.11
pre-WorkItems
```

После новой версии:

```text
sessions visible
events readable
runs intact
artifacts intact
```

---

# 43. Backup/restore acceptance

Перед destructive migrations:

```bash
npm run backup
```

Должен быть автоматический restore test:

```text
backup
→ mutate DB
→ restore
→ compare
```

---

# 44. Git safety tests

Самая важная группа destructive tests.

Проверять:

```text
TaskBridge никогда не:
- git reset --hard main без explicit request
- удаляет чужой worktree
- включает чужие изменения в commit
- переключает main checkout
- теряет untracked files
```

Создать fixture repository с «чужими изменениями».

Agent должен изменить только разрешённые файлы.

---

# 45. Verification separation

Отдельно regression test:

```text
agent status = SUCCEEDED
verification = FAILED
```

UI обязан показать:

```text
Agent finished
Verification failed
```

а не общий зелёный Success.

Это важный архитектурный инвариант.

---

# 46. Project removal

Сценарий:

```text
registered Project
→ Sessions exist
→ unregister Project
```

Проверяем:

```text
folder untouched
sessions untouched
history accessible
```

если политика остаётся именно такой.

---

# 47. Process restart tests

Обязательный suite:

```text
restart idle server
restart during agent generation
restart during tool call
restart during verification
restart during artifact write
restart during scheduled invocation
```

После восстановления состояние не должно превращаться в ложный SUCCESS.

---

# 48. Kill/crash tests

Инъекция аварий:

```text
kill Pi
kill OMP
kill TaskBridge
kill model server
kill Relay
lose network
```

Проверяем:

```text
correct error classification
recoverability
no duplicate execution
```

---

# 49. Local model regression

Поскольку TaskBridge ещё управляет моделями:

```text
server already running
server stopped
start managed model
model launch fails
health unavailable
busy slot
```

Эти tests нельзя случайно потерять во время OMP-рефакторинга.

---

# 50. UI regression screenshots

Для Android/Desktop полезно иметь несколько стабильных screenshot tests, но не на каждый пиксель приложения.

Ключевые состояния:

```text
Projects
Sessions
Chat
long tool output
approval
offline
Resume Preview
Work Item
Scheduled Job
```

Использовать их как visual smoke, а не как единственный функциональный тест.

---

# 51. Web regression

Не забывать PWA после KMP изменений.

Обязательно:

```text
load history
live message
edit
delete
regen
tool output
offline/reconnect
relay
```

Особенно после изменений общего protocol/API.

---

# 52. API backward compatibility

Для additive MR:

```text
старый Android client
↔
новый server
```

должен продолжать работать, если API version не повышена.

И:

```text
new Android
↔
previous server
```

либо работает, либо явно сообщает:

```text
SERVER_TOO_OLD
```

Не mysterious serialization failure.

---

# 53. Protocol version tests

Для Relay:

```text
same protocol
older supported
older unsupported
future unsupported
```

Ошибка должна быть явной.

---

# 54. Soak tests

Перед крупным релизом:

```text
TaskBridge server 12–24h

many sessions
periodic jobs
model start/stop
network reconnects
```

Следить:

```text
memory leak
fd leak
zombie processes
growing timers
SQLite locks
event backlog
```

---

# 55. Stress

Синтетически:

```text
50 sessions
10 concurrent active
100k events
1000 commands
rapid reconnects
large artifacts
```

Не потому что пользователь обычно так делает, а чтобы найти архитектурные пределы.

---

# 56. Security regression

Перед release:

```text
path traversal
artifact traversal
unauthorized API
revoked device
malformed token
oversized frame
oversized upload
invalid JSON
command replay
cross-project access
```

И обязательно:

```bash
npm run check:secrets
```

---

# 57. Что запускать после каждого маленького commit

Сделать `test:fast`.

Например концептуально:

```bash
npm run check
node --test \
  tests/store.test.mjs \
  tests/chat.test.mjs \
  tests/event-window.test.mjs \
  tests/git.test.mjs
```

Плюс затронутые tests.

KMP при KMP изменениях:

```bash
./gradlew :core:client:jvmTest :shared:jvmTest
```

Цель — быстрый feedback.

---

# 58. Что запускать перед каждым MR

`test:regression`:

```text
npm run check
npm test
KMP core tests
KMP shared tests
Android compile
Desktop compile
```

Плюс область MR:

```text
Cloud MR → test:cloud
Runtime MR → smoke:pi/omp
Git MR → worktree integration
```

---

# 59. Что запускать перед merge архитектурного MR

Например:

```text
Resume
ContextBroker
ArtifactStore
Transport
AgentRuntime
OMP
```

добавляем:

```text
full server suite
full KMP suite
integration
Android emulator E2E
real-device smoke
restart test
performance comparison
```

---

# 60. Перед release

Я бы ввёл один обязательный `release acceptance`.

Минимальная цепочка:

```text
Clean installation

Pair Android
→ register Project
→ start Pi Session
→ send prompt
→ tool executes
→ approval
→ follow-up
→ edit
→ history pagination

→ create Work Item
→ Resume into new Session
→ verify Git worktree

→ Run Recipe manually
→ schedule Invocation

→ switch Wi-Fi → mobile/Relay
→ continue chat
→ network loss/reconnect

→ start OMP Session
→ tool execution
→ verification

→ restart TaskBridge
→ everything still visible
```

Если хоть один этап сломан — release blocked.

---

# 61. Предлагаемая структура tests

Я бы постепенно пришёл к:

```text
tests/
├── unit/
│   ├── work-items
│   ├── resume
│   ├── memory
│   ├── context
│   ├── recipes
│   ├── scheduler
│   ├── artifacts
│   └── runners
│
├── integration/
│   ├── sqlite
│   ├── git
│   ├── pi
│   ├── omp
│   ├── relay
│   └── migrations
│
├── fixtures/
│   ├── chat
│   ├── pi-rpc
│   ├── omp-rpc
│   ├── repositories
│   └── databases
│
├── e2e/
│   ├── local
│   ├── relay
│   └── runtime
│
└── stress/
```

Не обязательно переносить существующие тесты сразу. Это целевая структура.

---

# 62. CI pipeline

В итоге я бы сделал четыре job-группы.

### PR Fast

```text
lint/check
Node unit
KMP JVM unit
```

### PR Full

```text
all Node
Cloud
KMP
build APK
Desktop compile
migration fixtures
```

### Main/Nightly

```text
stress
soak-lite
large history
relay chaos
Pi RPC
OMP RPC
```

### Release

```text
all previous
Android emulator E2E
artifact/security
migration/backup restore
runtime A/B sanity
```

---

# 63. Definition of Done каждого MR

MR нельзя считать завершённым только потому, что:

> код компилируется.

Для каждого MR требуем:

```text
Feature tests PASS

Regression suite PASS

No new baseline failures

Migration tested if schema changed

Existing user data preserved

Failure scenario tested

Relevant Android/Desktop/Web tested

git diff --check PASS

No unrelated files touched

Known limitations documented
```

---

# 64. Самое важное — Test Matrix по MR

Для нашего roadmap я бы установил такую обязательную матрицу:

| MR | Обязательные дополнительные проверки |
|---|---|
| Project Dashboard | API + Web/KMP UI + old Sessions |
| Work Items | CRUD + restart + project removal |
| WorkItem↔Sessions | relationship integrity + deletion |
| Resume | Git race + worktree + preview/revalidate |
| Run Recipes | params + immutable original Session |
| Scheduler | fake clock + misfire + concurrency |
| Recap | deterministic extraction/fallback |
| Memory | unavailable/stale/dedup/read-only |
| ContextBroker | budgets/provenance/dedup |
| project-md | path/security/size |
| AST | accuracy + grep fallback |
| LSP | failure fallback + diagnostics |
| AST Edit | stale preview + syntax verification |
| Artifact Store | size thresholds + integrity |
| Transport | Local compatibility |
| Relay | disconnect/reconnect/SYNC |
| Durable commands | duplicate/ACK-loss/crash |
| E2EE | relay cannot inspect payload |
| AgentRuntime | Pi parity |
| OMP | RPC fixtures + runtime parity |
| Subagents | cleanup/cancel/artifacts |
| Archive | search correctness/no hidden mutation |

---

# Итог

Если сделать только две вещи из всего плана, то самые важные будут:

**1. Постоянный Core Regression Suite**, который проходит после каждого MR.

**2. Golden integration scenarios**, одинаково прогоняемые через Web/KMP, LAN/Relay и позднее Pi/OMP.

Тогда мы сможем довольно агрессивно менять внутренности TaskBridge — Memory, ContextBroker, Scheduler, transport и даже заменить Pi на OMP — при этом тесты будут отвечать на главный вопрос:

> **«Для пользователя TaskBridge всё ещё делает то же самое, только лучше?»**

Именно такой regression contract я бы зафиксировал **до начала MR-02/MR-03**, потому что чем позже его вводить, тем сложнее будет отличить новую ошибку от старого поведения.