# FP-CORE-STABILITY — чек-лист ремонта ядра Follow Plan

Это **не** активный Follow Plan и не замена `docs/TaskBridge_SYNC_IMPORT_PLAN.md`
(его S-015 остаётся ссылкой на найденный блокирующий дефект). Это технический
чек-лист для локального агента: дефект → правка → тест → коммит → результат.
Порядок — из разбора жизненного цикла (`.local/fp-sync/core-lifecycle-trace.md`).

## Почему нельзя вести этот ремонт самим Follow Plan

Механизм, который ремонтируется, не гарантирует фиксацию шага. Использовать его
для управления собственным ремонтом — значит снова получить повторные циклы и
недостоверный прогресс. Поэтому: обычная работа с обычными коммитами, адресные
тесты после каждой правки, полный gate в конце.

## Чек-лист

| ID | Дефект | Правка | Тест | Коммит | Статус |
|---|---|---|---|---|---|
| CORE-00 | Нет воспроизведения: «checkpoint принят, шаг остался TODO» | — | `tests/follow-plan-core-repro.test.mjs` (4 теста) | `a3eb593` test(follow-plan): reproduce checkpoint loss and silent rejection | DONE |
| CORE-01 | Исход checkpoint невидим: `IGNORED` без причины, `PLAN_STEP_CHECKPOINT` читается как «шаг закрыт» | `CHECKPOINT_OUTCOMES`, `CHECKPOINT_REASONS`, `#outcome()`, обёртка `onSettled` (APPLIED считается по фактической ревизии файла), события `PLAN_CHECKPOINT_APPLIED/_RECEIVED/_REJECTED` в сервисе, подписи в web | репро: REJECTED/STATE_INACTIVE, APPLIED/appliedRevision, RECEIVED/NOTHING_TO_APPLY, REJECTED/FOREIGN_COMMAND; сервис: событие `PLAN_CHECKPOINT_REJECTED` с `checkpointId`/`reasonCode` | `fix(follow-plan): expose checkpoint outcomes` | DONE |
| CORE-02 | `PAUSED_REVIEW` съедает допустимый checkpoint (преждевременный переход FSM) | различать причину паузы: задержка settle vs STOP при операторе vs конфликт; не разрешать следующий dispatch из `PAUSED_REVIEW` без явного Resume/Reconcile | сценарий `S-001 RUNNING → checkpoint → premature PAUSED_REVIEW → onSettled`: шаг закрывается ровно один раз; при STOP — не применяется | `fix(follow-plan): correct checkpoint lifecycle guards` | TODO |
| CORE-03 | Применение и дедупликация: один и тот же checkpoint не должен применяться дважды | идемпотентность по `checkpointId` (cycleId+stepId+decision+completed), повторный `agent_settled` не двигает цикл | дублированный checkpoint → `RECEIVED`, файл не меняется второй раз | `fix(follow-plan): apply checkpoints exactly once` | TODO |
| CORE-04 | SQLite binding ↔ Markdown расходятся (`expected_revision=1` при файле revision 2) | обновлять `expected_revision`/`expected_hash` после успешной записи; при расхождении — конфликт, а не «продолжаем»; recovery после частичной записи | инъекция сбоя между записью файла и binding → восстановление либо явный конфликт | `fix(follow-plan): reconcile plan binding and file` | TODO |
| CORE-05 | Обычные сообщения во время шага | проверить политику: сообщение не отменяет цикл, ответ — на безопасной границе; отдельный тест на steering | settle с чужим `commandId` не ломает цикл (уже покрыто репро), + сквозной сценарий с реальным ходом | `fix(follow-plan): isolate chat from plan execution` | TODO (частично подтверждено) |
| CORE-06 | Сквозная приёмка | три шага с реальным Pi, между шагами обычное сообщение, перезапуск, два клиента | 3/3 DONE, ровно один `PLAN_COMPLETED`, нет ручных «продолжай», Desktop и Android видят один прогресс | `test(follow-plan): verify lifecycle recovery` | TODO |

## Проверка APPLIED после приёмки FP-FIX-05 (CORE-02, шаг 0)

Замечание принято: смена ревизии не доказывает применение `completedStepIds` — на
живом прогоне файл ушёл на revision 2 (F-001 и S-015), а S-001 остался `TODO`.

Что изменено:

- `APPLIED` теперь означает **собственную запись этого settle** (`lastApply`),
  а не «ревизия изменилась»: чужая правка между чтениями даёт
  `externalRevisionChange: true`, но не `APPLIED`.
- Исход называет, что именно применено: `appliedStepIds`, `appliedFindingIds`,
  `confirmedStepIds`, `unconfirmedStepIds`, `completionApplied`,
  `revisionBefore`, `revisionAfter`.
- `completionApplied` — единственный признак «шаг(и) действительно закрыты»;
  UI и FSM обязаны опираться на него, а не на `APPLIED`.

Тесты (в `tests/follow-plan-core-repro.test.mjs`):

| Тест | Что доказывает |
|---|---|
| находка без закрытого шага | файл записан (rev 1→2), `completionApplied=false`, шаг остался `TODO` |
| ревизия изменилась чужой записью | `appliedStepIds=[]`, `unconfirmedStepIds=['S-001']`, `externalRevisionChange`, `outcome != APPLIED` |
| базовая линия | `appliedStepIds=['S-001']`, `confirmedStepIds=['S-001']`, `completionApplied=true` |

## Что уже сделано (CORE-00, CORE-01)

- Воспроизведение: 4 теста, включая доказательство, что вклинившееся сообщение
  checkpoint **не** съедает (чужой settle безопасен) — прежняя гипотеза снята.
- Исход применения теперь называется: `APPLIED` / `RECEIVED` / `REJECTED` +
  `reasonCode`, `checkpointId`, `cycleId`, `stepId`, `planRevision`, `runId`.
- APPLIED определяется по фактической ревизии файла до и после settle, а не по
  коду ответа: «принят» больше нельзя выдать за «применён».
- Событие `PLAN_STEP_CHECKPOINT` не переименовано (совместимость клиентов), но в
  Web его подпись теперь «Checkpoint получен», а исход приходит отдельным событием.
- `PAUSED_REVIEW` больше не глотает checkpoint молча: сервис публикует
  `PLAN_CHECKPOINT_REJECTED` с причиной, до вызова follower.

## Приёмка CORE-01 (факт)

| Проверка | Результат |
|---|---|
| `tests/follow-plan-core-repro.test.mjs` | 6/6, включая REJECTED/STATE_INACTIVE с `checkpointId` и неизменённым файлом |
| `tests/follow-plan-service.test.mjs` | 40/40, включая публикацию `PLAN_CHECKPOINT_REJECTED` (`reasonCode=STATE_INACTIVE`) |
| адресные: follower/checkpoint/service/api/web/recovery/lifecycle | 144/144 |
| полный `npm test` | 1639 тестов, 1635 pass, 4 skipped, **0 fail** |

## CORE-02A — результат (2026-10-24)

Цель: воспроизвести потерю `completedStepIds` в активном `RUNNING_STEP` через
полный путь обработки (`FollowPlanService.turnSettled` → follower), а не прямым
вызовом.

| Сценарий | Результат |
|---|---|
| `RUNNING_STEP` + валидный `CONTINUE` с `completedStepIds` | **PASS**: шаг `DONE`, `completionApplied=true`, `confirmedStepIds=[S-001]`, следующий S-002, событие `PLAN_CHECKPOINT_APPLIED` |
| finding + завершение шага | **PASS**: обе операции в файле, `appliedFindingIds=[F-001]` |
| finding без завершения | **PASS**: finding записан, шаг `TODO`, шаг не перескочил на S-002 |
| STOP → поздний settle | **PASS**: шаг не засчитан, отправок нет, STOP сохраняет приоритет |
| законный `BLOCKED` → `PAUSED_REVIEW` | **PASS**: пауза остаётся, из неё ничего не отправляется |
| повторный settle того же хода | **PASS**: файл не переписан |
| внешний CAS-конфликт | **PASS**: `PLAN_REVISION_CONFLICT`/`REVISION_CONFLICT`, файл не перезаписан |
| `turnFailed` → поздний settle | **PASS**: `REJECTED/STATE_INACTIVE`, шаг не засчитан, скрытого dispatch нет |
| рестарт после подтверждённого шага | **PASS**: шаг остаётся `DONE`, `PAUSED_REVIEW` без повтора S-001 |
| отказ валидации (чужой `cycleId`) | **PASS**: отказ назван словами (`cycleId…`), шаг не засчитан |

Вывод: **в текущем коде потеря завершения в активном `RUNNING_STEP` не
воспроизводится** — счастливый путь работает. Значит живой инцидент объясняется
чем-то, чего в этом прогоне нет; чтобы это не осталось тайной, добавлена
публикация причин отказа валидации (`problems`) в том же исходе checkpoint'а —
раньше отказ `inspectCheckpoint` был невидим (в событии были только
`evidenceProblems`).

Открытые кандидаты, которые ещё не проверены (и не требуют изменения FSM):
различие `runId`/`commandId` в момент settle на живом сервере, очистка
`_planCheckpoint` между ходами в `TaskManager`, и поведение при чужом
`commandId` на реальном пути.

## CORE-02B — причина найдена и исправлена (2026-10-24)

Живой сценарий воспроизведён на **полном пути** TaskManager → FollowPlanService →
PlanFollower (тестовый Pi присылает те же кадры, что настоящий):

```
PLAN_STEP_STARTED S-001 (RUNNING_STEP)
  → Pi: tool_execution_start taskbridge_plan_checkpoint  (checkpoint валиден)
  → в сессию приходит сообщение «сейчас» (now:true, steering)
  → runtime.commandId = команда ОБЫЧНОГО сообщения
  → agent_settled планового хода
  → PLAN_STEP_CHECKPOINT CONTINUE (опубликован)
  → PLAN_CHECKPOINT_REJECTED / FOREIGN_COMMAND
  → S-001 остаётся TODO, binding остаётся RUNNING_STEP (цикл зависает)
```

| Причина | Исправление |
|---|---|
| `TaskManager` передавал в `turnSettled` **текущий** `runtime.commandId`, а вклинившееся сообщение его перезаписывает | команда запоминается в момент захвата checkpoint (`_planCheckpointCommandId`) и передаётся в settle как команда хода-владельца; текущая используется только когда checkpoint нет |

Тесты: `tests/follow-plan-run-ownership.test.mjs` — обычное сообщение в очередь
(2 прогона), steering «сейчас» (2 прогона), «продолжай» при активном шаге: во всех
шаг закрывается, `completionApplied=true`, `confirmedStepIds=[S-001]`, отклонений
`FOREIGN_COMMAND` нет. До исправления steering-прогоны падали (шаг оставался
`TODO`), то есть дефект был **воспроизведён и исправлен**, а не «не воспроизвёлся».

Не сделано (честно): матрица LIVE-01…LIVE-08 на настоящем Pi 1.4.0 с реальным
провайдером. Изолированный стенд с тестовым Pi её заменяет только частично:
порядок кадров тот же, но поведение модели и тайминги другие.

## Живая приёмка (26.10.2026) и второй дефект

Стенд: изолированный сервер, настоящий Pi 1.4.0, модель `deepseek/deepseek-flash`,
план из трёх шагов (`calc.mjs` + тесты), артефакты в `.local/fp-live/`.

| Сценарий | Результат |
|---|---|
| LIVE-01: три шага без сообщений | **PASS** — 3/3 `DONE`, один `PLAN_COMPLETED`, 3 checkpoint (CONTINUE, CONTINUE, COMPLETE), все `PLAN_CHECKPOINT_APPLIED` с `confirmed=[S-001]/[S-002]/[S-003]` |
| LIVE-02: сообщение между шагами | **PASS** — 3/3 `DONE`, сообщение обработано |
| LIVE-03: сообщение «сейчас» (steering) во время шага | **FAIL → исправлено** (см. ниже) |

### Второй дефект (нашёлся только на живом Pi)

```
03:54:37 PLAN_STEP_STARTED S-001 (RUNNING_STEP)
03:54:40 USER_MESSAGE mode=steer        (turn 2)
03:54:44 PLAN_CHECKPOINT_REJECTED       reasonCode=FOREIGN_COMMAND, checkpointId=null
03:54:45 TASK_SUCCEEDED
→ тишина: binding остаётся RUNNING_STEP, все шаги TODO
```

Steering заменяет ход: Pi заканчивает ответ, checkpoint планового шага **не
приходит вовсе**, а settle приносит чужую команду. Прежний код только отклонял
такой settle — цикл зависал навсегда (ни паузы, ни разбора, ни следующего шага).

Исправление: чужой settle без checkpoint при активном цикле теперь **явная
пауза** `PAUSED_REVIEW` с причиной `FOREIGN_SETTLE_NO_CHECKPOINT` (шаг, цикл и
обе команды в событии). Шаг не засчитывается, скрытого dispatch нет, оператор
видит «нужен разбор». Settle **своего** хода без checkpoint идёт прежним путём
follower'а (контрольный ход / пауза).

Тесты: `tests/follow-plan-lifecycle.test.mjs` — два новых случая (чужой settle без
checkpoint → пауза; свой settle без checkpoint → прежнее поведение), 12/12.
Полный `npm test` — 1658 тестов, 0 падений (лог `.local/fp-sync/npm-test-6.log`).

## LIVE-03 после исправления (второй живой прогон)

Повтор на том же изолированном стенде (`.local/fp-live/LIVE-03d/`):

- зависание ушло: steering больше не съедает шаг — S-001 закрыт, план пошёл дальше;
- затем S-002 выдавался **три раза**, модель каждый раз отвечала `CONTINUE` с пустым
  `completedStepIds` (`PLAN_CHECKPOINT_RECEIVED / NOTHING_TO_APPLY`), а четвёртый
  settle пришёл с `REVISION_CONFLICT` → штатная пауза `PAUSED_REVIEW`
  (`PLAN_CONFLICT`), без ложного `DONE` и без скрытого dispatch.

Что это значит: **зависание исправлено**, но живой прогон вскрыл следующий класс
дефектов (для CORE-03/04):

1. модель не закрывает шаг, а контроллер повторно выдаёт тот же S-002 — три
   дорогих хода подряд; лимит `noProgress` срабатывает только на третьем;
2. `REVISION_CONFLICT` возник потому, что файл плана изменился между выдачей хода
   и settle (агент правит `PLAN.md` в рабочем каталоге) — согласование
   binding ↔ Markdown и восстановление после такого — это CORE-04;
3. сообщение `PLAN_CHECKPOINT_APPLIED` называло `dispatchStepId` (уже следующий
   шаг) вместо закрытого; исправлено: теперь перечисляются закрытые шаги и есть
   поле `closedStepIds`.

Гейт после правки: `npm test` — **1660 тестов, 1656 pass, 4 skipped, 0 fail**
(лог `.local/fp-sync/npm-test-7.log`).

## Правила для следующих шагов

- Не менять FSM и CAS одновременно.
- Каждая правка — с тестом, который падал бы до неё.
- После каждой правки адресные тесты, в конце — полный gate.
- Рабочий сервер, пользовательские сессии, Strata и `config.json` не трогать; push
  без отдельного разрешения не делать.
