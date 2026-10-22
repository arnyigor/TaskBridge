# Follow Plan — контракт с Pi (FP-00)

Дата: 2026-10-22. База: установленный **Pi 1.4.0**, TaskBridge `master`.
Задача этапа: подтвердить на настоящем Pi поверхность, на которой стоит Follow Plan,
до написания `PlanFollower` (ТЗ `TaskBridge_Follow_Plan_TZ_v0.2.md`, этап FP-00).

Стенды (изолированные: свой agent-dir, свой workspace, свой каталог сессий;
рабочий сервер TaskBridge, Strata и чужие Pi-сессии не затрагивались):

```bash
node experiments/pi-hooks/compat-check.mjs        --model deepseek/deepseek-flash --out .local/fp-00/rpc-1.4.0
node experiments/pi-hooks/follow-plan-compat.mjs  --model deepseek/deepseek-flash --out .local/fp-00/run3
```

## 1. Что подтверждено фактическим прогоном

| Проверка | Результат на 1.4.0 |
|---|---|
| RPC-поверхность TaskBridge (`get_state`, `prompt`, `set_model`, `steer`, `follow_up`, `compact`, `abort`, перезапуск сохранённой сессии) | 8/8 ✅ (`compat-check.mjs`) — диапазон `SUPPORTED_PI` расширен до `<1.5.0` |
| Extension-tool `pi.registerTool()` виден модели и вызывается | ✅ `tool_execution_start`/`end` пришли, `isError: false` |
| Аргументы checkpoint-инструмента приходят в RPC целиком | ✅ `{planId, revision, cycleId, decision, completedStepIds, nextStepId, evidence[]}` — JSON, не строка |
| `turn_end` и `agent_before_settle` | ✅ оба хука вызваны; `agent_before_settle.outcome = "completed"`, `context.llmMessages` доступен (7 сообщений) |
| Однократный `continue: true` из `agent_before_settle` | ✅ ровно один дополнительный запрос модели и **один** `agent_settled` (петли нет) |
| `/abort` (STOP) | ✅ `agent_settled` приходит **внутри** ожидания ответа на `abort`, `aborted: true`, `isStreaming: false`; сессия после этого принимает новый `prompt` (`aborted: false`) |
| `follow_up` во время хода | ✅ `disposition: "queued"`, доставлен, `agent_end` фиксируется **до** финального `agent_settled` |

Отчёты: `.local/fp-00/run3/report.json` (Follow Plan), `.local/fp-00/rpc-1.4.0/report.json`
(RPC), журналы хуков `.local/fp-00/run3/hook-*.jsonl`. `.local/` в git не попадает —
при воспроизведении цифры надо получить заново.

## 2. Контракт checkpoint-инструмента

Регистрация (`pi.registerTool`): `name`, `label`, `description`, `promptSnippet`,
`parameters` — **обычная JSON Schema** (production-пример: `pi-extension/taskbridge-media.js`),
`execute(toolCallId, params)` → `{ content: [{type:'text',…}], details: {...} }`.
`details` до контроллера через RPC не доходит как структура: в кадре
`tool_execution_end.result` лежит результат целиком, а **надёжный** источник —
`tool_execution_start.args` (валидированный Pi по схеме). Поэтому контроллер
принимает checkpoint по `args`, а `execute()` оставляет только подтверждение модели.

Проверенная схема (fixture `experiments/pi-hooks/follow-plan-checkpoint-fixture.js`):
`planId`, `revision`, `cycleId`, `decision` ∈ `CONTINUE|REPLAN|COMPLETE|BLOCKED|NEED_INPUT|NO_PROGRESS`
(обязательные), плюс `completedStepIds[]`, `evidence[]`, `findings[]`, `nextStepId`.

Расширение подключается так же, как остальные TaskBridge-расширения: `pi -e <file>`,
конфигурация через переменные окружения (`src/task-manager.mjs`, ветки 3107/3131/3144).
Регистрацию tool и хуков можно проверять без TaskBridge — этим и является FP-00.

## 3. Что из этого следует для FP-02/FP-03

1. **Второй канал для checkpoint не нужен.** Контроллер видит `tool_execution_start`
   с `toolName` и `args` в обычном потоке Pi-кадров, которые TaskBridge уже
   форвардит (`src/event-trim.mjs`, `src/task-manager.mjs`). HTTP-колбэк из
   расширения в TaskBridge не требуется.
2. **`agent_end` — не граница цикла.** При `follow_up`/очереди `agent_end`
   приходит раньше работы, инициированной после него. Решение о следующем шаге
   принимается только по `agent_settled` (и по `aborted`), как уже делает
   `src/task-manager.mjs`.
3. **Контрольный ход считает контроллер, а не Pi.** Однократный `continue: true`
   добавляет один *запрос*, но не один *turn*: если модель в этом запросе вызвала
   инструмент, ходов будет два-три (в прогоне B — 3 `turn_start` при 1 `agent_settled`).
   Поэтому лимит «не более одного проверочного хода» должен считаться в
   `PlanFollower` по собственной записи цикла, а не по числу ходов Pi.
4. **Fallback-проверку лучше делать внешним `prompt` из контроллера.** Он виден в
   RPC, попадает под STOP/epoch и учитывается в бюджете; `continue` из
   `agent_before_settle` оставить неиспользованным — он не отменяем со стороны
   TaskBridge и не даёт точки остановки.

## 4. Не подтверждено / риски

- Модель **не обязана** вызывать checkpoint-инструмент: в прогоне A она вызвала его
  по прямой инструкции, в прогоне B — только после контрольного сообщения. Отсюда
  правило ТЗ: отсутствие валидного checkpoint ≠ завершение.
- Не проверялись: параллельные tool calls в одном ответе, approval-гейт для
  extension-tool (стенд запускался с `--approve`), компакция во время цикла,
  поведение при 413/429 и provider wait, длинный reasoning с STOP посреди него.
- Не проверялся TaskBridge-side STOP epoch и дедупликация `commandId` — это FP-03,
  и проверять это нужно на `RunCoordinator`/`QueuePump`, не на Pi.
- Windows-специфика (`rename` занятого файла плана) относится к FP-01, не к Pi.
- Один прогон на одной модели (`deepseek/deepseek-flash`) — это свидетельство о
  протоколе Pi, а не о поведении конкретной модели в цикле.

## 5. Статус этапа

FP-00 закрыт по механизму: tool + хуки + границы хода проверены на реальном Pi.
Продуктовые развилки ТЗ §13 (формат файла, автономность, объём автоправок,
строгость проверок) остаются открытыми и блокируют FP-01 в части формата.
