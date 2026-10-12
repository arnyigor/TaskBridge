# Карта покрытия: TESTING_PLAN.md → реальные файлы

`TESTING_PLAN.md` описывает, **что** должно быть проверено. Этот файл отвечает на
другой вопрос: **чем** это проверяется сейчас и где проверки нет. Каждое «есть»
здесь указывает на файл; где файла нет — так и написано, без «планируется».

Исполняемая часть — [`scripts/regression-suite.mjs`](../scripts/regression-suite.mjs):

```bash
npm run test:core          # секции server chat git files auth project
npm run test:core:kmp      # то же + Gradle (api/client/shared jvmTest + assembleDebug)
node scripts/regression-suite.mjs --list    # карта «секция → файлы»
node scripts/regression-suite.mjs project   # одна секция
```

Проверено прогоном (2026-10-11, рабочее дерево, ~2 минуты на node-часть и ~4 на Gradle):

| Секция | Результат |
|---|---|
| server | 160/160 (72 с) |
| chat | 192/193 (1 штатный skip, 13 с) |
| git | 13/13 |
| files | 30/30 |
| auth | 26/26 |
| project (MR-01…MR-06) | 35/35 |
| Gradle: `:api:jvmTest`, `:client:jvmTest`, `:shared:jvmTest`, `:androidApp:assembleDebug` | 4/4 ✔ |

**10/10 секций зелёные.** Плавающий тест очереди в `server` появлялся в одном прогоне
из трёх и исчез при `--concurrency=2` — см. [KNOWN_BASELINE_FAILURES.md](../KNOWN_BASELINE_FAILURES.md).

## §2 Baseline

| Требование | Как выполнено |
|---|---|
| снять commit/node/java/Android/Pi | [`KNOWN_BASELINE_FAILURES.md`](../KNOWN_BASELINE_FAILURES.md) — таблица окружения, отдельный worktree на коммите (`.local/baseline-head`) |
| `npm run check`, `npm test`, `git diff --check` | там же, с числами на HEAD |
| известные падения — объективно | там же: на HEAD падает только плавающий `context-limit`; `strata-metrics` на HEAD проходит, значит его падение — из незакоммиченных правок |
| KMP-команды | `npm run test:core:kmp` (те же четыре Gradle-задачи) |

## §3–§8 Core Regression Suite

Полное соответствие «пункт плана → файл» печатает `--list`. Ниже — по секциям, с
пробелами.

| Секция плана | Состояние | Файлы |
|---|---|---|
| Server: запуск, SQLite, сессия целиком, очередь, steering, cancel, restart, compact, model/thinking, завершение, повторное открытие | ✅ | `tests/server.test.mjs`, `manager.test.mjs`, `store.test.mjs`, `store-identity.test.mjs`, `send-flow.test.mjs`, `send-e2e.test.mjs`, `queue-http.test.mjs`, `runs.test.mjs`, `runtime-faults.test.mjs`, `session-history.test.mjs`, `context-limit.test.mjs`, `context-report.test.mjs`, `api-contract.test.mjs` |
| Chat: история, live SSE, reconnect, gap recovery, страницы старой истории, `reachedStart`, большие ответы, размышления, инструменты, частичный ход, edit/delete/regenerate/fork/варианты, `TURN_TRUNCATED`/`TURN_EDITED` | ✅ | `tests/chat.test.mjs`, `chat-delete-answer.test.mjs`, `clear-chat.test.mjs`, `undo-turn.test.mjs`, `event-stream.test.mjs`, `event-window.test.mjs`, `event-trim.test.mjs`, `output-files.test.mjs`, `web-css.test.mjs`, `machine-load-panel.test.mjs` |
| Git: чистый/грязный workspace, worktree, diff, staged/untracked/binary, усечённый снимок, verification | ✅ (кроме verification — см. ниже) | `tests/git.test.mjs`, `project-trust.test.mjs`; verification покрыта в `tests/server.test.mjs` и `tests/invocations.test.mjs` |
| Files: вложения, текст, картинка, отсутствующий/удалённый файл, дубликат имени, большой файл | ✅ | `tests/files-contained.test.mjs`, `multipart.test.mjs`, `open-local.test.mjs`, `open-machine.test.mjs`, `project-browser.test.mjs` |
| Auth: pairing, bearer, отозванный/негодный токен, запрещённый Origin | ✅ | `tests/cloud-relay-auth.test.mjs`, `remote-access.test.mjs`, `access-machine.test.mjs`, `lan-mode.test.mjs`, `proxy.test.mjs` |
| **Пробел**: «истёкший/отвергнутый device», «duplicate filename», «image» на уровне HTTP | ⚠️ частично | дубликаты имён и картинки покрыты на уровне KMP/`files-contained`, отдельного HTTP-теста на «просроченное устройство» нет |

## §4 Golden Chat Fixtures

| Требование | Состояние |
|---|---|
| канонический корпус сценариев, сверка KMP `ChatReducer` с web-редьюсером | ✅ механизм есть: `tests/fixtures/chat/*.json` + `ChatReducerGoldenTest.kt` (`scripts/export-chat-fixtures.mjs` их экспортирует) |
| обязательный список сценариев | ✅ корпус из 13 файлов, список закреплён в `ChatReducerGoldenTest.theCanonicalCorpusIsPresent` (фикстура не может исчезнуть незаметно): `basic`, `follow-up`, `queued`, `steer`, `cancel`, `send-now`, `regenerate`, `edit-answer`, `edit-turn`, `delete-turn`, `thinking`, `model-error`, `fork-from` |
| `06-edit` / `TURN_EDITED` | ✅ добавлено: `edit-turn.json` — правка реплики оператора на месте (`TURN_EDITED` + `TURN_TRUNCATED` в одном файле), сверено двумя редьюсерами |
| `02-thinking` | ✅ добавлено: `thinking.json` с частью `type: "thinking"` в финальном сообщении. Форма взята из живых данных, а не придумана: в 159 сессиях на этом сервере **0 кадров `thinking_delta`** и **1002 сообщения с такой частью** — модели здесь не стримят рассуждение. Поток дельт фикстурой не покрыт по этой же причине (и он был бы удалён `trimStreamingDeltas` при загрузке истории) |
| `04-large-tool-output` | ⚠️ golden-файла нет осознанно: он внёс бы в репозиторий мегабайты, а гарантия (потолок размера страницы истории) уже проверяется `tests/event-window.test.mjs` и `tests/server.test.mjs` («page cut by size») |

### Чем корпус генерируется

`node scripts/export-chat-fixtures.mjs` — реальные сессии на fake-pi, события с живого
SSE, ожидание считает `web/chat-state.mjs` (эталон). Два сценария генератора сейчас не
снимаются (`crash-and-resume`, `model-error`) — **воспроизводится на HEAD**, разбор в
[KNOWN_BASELINE_FAILURES.md](../KNOWN_BASELINE_FAILURES.md); генератор сообщает о них и
продолжает, чтобы остальные файлы не оставались устаревшими.

## §5 Не проверять текст LLM как golden output

✅ соблюдается: golden-файлы фиксируют **редьюсер** (ходы, инструменты, статусы), а
не формулировки модели; тексты ответов в фикстурах — короткие маркеры.

## §6–§8 History / Android / crash acceptance

| Пункт | Состояние |
|---|---|
| History regression (страницы, курсоры, дедупликация) | ✅ `tests/event-window.test.mjs`, `tests/event-stream.test.mjs`, `tests/chat.test.mjs` + **новое**: `ChatHistoryPagingTest.kt` (перекрывающиеся страницы, потолок страниц, курсор не двигается) |
| Android crash acceptance (краш при просмотре истории) | ⚠️ автоматики нет: проверено вручную на устройстве и эмуляторе (cache 12.5 МБ → 2.1 МБ, 0 OOM, 10 страниц одним действием). Скрипта «прогнать длинную сессию и проверить отсутствие OOM» нет |

## §10–§26 Фичи проекта (сделаны в MR-01…MR-06)

| Раздел плана | Состояние | Файлы |
|---|---|---|
| §10 Work Items | ✅ создание/фильтры/счётчики/отказы/перезапуск | `tests/work-items.test.mjs` |
| §11 Resume Engine (чистый/грязный репозиторий, удалённый worktree) | ✅ + git-факты проверены на **настоящем** репозитории; удалённый worktree — предупреждение и отказ | `tests/resume.test.mjs` |
| §12 Resume Preview/Launch race | ✅ `409 CONTEXT_CHANGED` с полем `changes` | `tests/resume.test.mjs` |
| §22–§24 Scheduler, misfire, concurrency | ✅ политики `SKIP`/`RUN_ONCE`/`CATCH_UP`, `SKIP_IF_RUNNING`/`QUEUE`/`REPLACE`, инвокации со статусом `SKIPPED` | `tests/schedules.test.mjs`, `tests/invocations.test.mjs` |
| §25 Parameterized rerun | ✅ запуск recipe с параметрами есть (`POST /api/recipes/:id/run`); `POST /api/tasks/:id/rerun` применяет модель/уровень к сессии; кнопка и выбор модели есть в веб-панели и KMP-чате | `tests/recipes.test.mjs`, `tests/rerun-parameters.test.mjs`, `tests/web-rerun-parameters.test.mjs`, `RerunApiTest.kt` |
| §26 Recipe determinism | ✅ параметры/подстановка только в разрешённых полях, опечатка в placeholder — отказ при сохранении | `tests/recipes.test.mjs` |

## Чего пока нет вообще (честно)

| Раздел плана | Что отсутствует |
|---|---|
| §9 Memory/performance regression | нет soak-прогонов и замеров памяти в автоматике (ручные замеры на телефоне были) |
| §13–§16 Context Broker, бюджет контекста, память, Memory Suggestions | функциональности нет — и тестов нет |
| §17 `project-md` | интеграции нет |
| §18–§21 AST/Search/Edit, Artifact spill и его безопасность | функциональности нет |
| §27–§33 сеть, relay, мобильный хаос, E2EE, offline outbox | есть базовые тесты relay/auth; хаос-тестов и E2EE-проверок нет |
| §34–§39 OMP adapter, Pi adapter, AgentEvent parity, capability, A/B | OMP не подключён |

## Правило

Меняете гарантию — меняете обе стороны: файл в `tests/` и строку в этой карте.
Карта, которая расходится с `--list`, бесполезна: сверяйтесь с
`node scripts/regression-suite.mjs --list`.
