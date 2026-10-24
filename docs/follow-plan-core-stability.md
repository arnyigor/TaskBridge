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

## Правила для следующих шагов

- Не менять FSM и CAS одновременно.
- Каждая правка — с тестом, который падал бы до неё.
- После каждой правки адресные тесты, в конце — полный gate.
- Рабочий сервер, пользовательские сессии, Strata и `config.json` не трогать; push
  без отдельного разрешения не делать.
