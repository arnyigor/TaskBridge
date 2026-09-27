# TaskBridge: KMP ↔ Web parity и roadmap agent harness

Дата аудита: 2026-09-27.

## Результат текущего этапа

- KMP получил типизированный каталог моделей, сведения о доступных остатках DeepSeek/WormSoft/RouterAI и ручное безопасное обновление каждого кабинета.
- KMP получил управление MCP: режимы `inherit / managed / off`, импорт конфигурации Pi, включение серверов и отдельных инструментов.
- Backend больше не использует глобальную ёмкость «одна генерация на весь компьютер». До четырёх независимых удалённых сессий запускаются параллельно; число задаётся `queue.maxConcurrentSessions` (1…16).
- Ограничения безопасности сохранены: один активный ход на сессию, один потребитель локального runtime, последовательная очередь сообщений сессии, сериализация общего workspace без worktree.
- `/api/info` сообщает `scheduler.activeTasks`, `maxConcurrentSessions` и `queuedTasks`; KMP показывает эти значения в настройках.

## Что есть в Web и KMP

| Возможность | Web | KMP после этапа | Следующее действие |
|---|---:|---:|---|
| Список/поиск/группировка сессий | Да | Да | — |
| Живой SSE-чат, восстановление курсора, история | Да | Да | Добавить дисковый cache/offline cold start |
| Очередь, steer, send-now, STOP | Да | Да | Chaos-тесты сети/перезапуска |
| Модели, thinking, favorites, compact | Да | Да | Показывать capability/cost metadata, когда backend начнёт её отдавать |
| Остатки провайдеров | Да | Да | Новые адаптеры только для провайдеров с официальным account API |
| MCP mode/server/tool controls | Да | Да | OAuth/health/latency и добавление/редактирование server definitions |
| Tool approvals | Да | Да | Политики «разрешить для сессии», журнал решений |
| Файлы, картинки, artifacts, полный tool output | Да | Да | Авторизованное открытие файла без системного browser cookie gap |
| Правка, удаление, regenerate, variants, fork | Да | Да | — |
| Создание/регистрация проектов | Да | Да | QR-сканирование на Android |
| Управление локальными моделями (load/unload/progress) | Да | Нет | P1: отдельный KMP-экран runtime |
| CPU/RAM/GPU и engine slots | Да | Частично | P1: типизированный `system/engine/local` dashboard |
| Apply diff / cleanup worktree | Да | Нет | P1: действия с подтверждением и preview diff |
| Импорт native Pi sessions | Да | Нет | P2: read-only discovery → explicit import |
| Cloud relay mode | Да | Нет | P2: transport abstraction вместо прямого LAN API |
| Durable offline cache/outbox после перезапуска клиента | Частично | Нет | P0: SQLDelight/Room, cursor + command ledger |
| QR pairing | Веб показывает код | Только ручной ввод | P1: CameraX/ML Kit scanner |

## Обязательный минимум production agent harness

### P0 — целостность выполнения

1. **Durable session/run state.** История, незавершённый run, approvals и idempotency key должны переживать перезапуск. OpenAI Agents SDK сохраняет session items и требует продолжать approval interruption тем же `RunState`; TaskBridge уже имеет server-side command ledger, но KMP outbox пока только in-memory.
2. **Cancellation и bounded execution.** У каждого run нужны STOP/abort, deadline, maximum turns и гарантированное освобождение ресурсов. Backend имеет cancel/kill fallback; следует добавить настраиваемые turn/tool deadlines и отдельный terminal reason.
3. **Concurrency + backpressure.** Лимит должен быть явным, наблюдаемым и разделённым по ресурсам: remote session slots, local model slots, per-session turn=1, workspace lock. Этот этап реализует базовый scheduler; следующий шаг — fair queue и per-provider limits.
4. **Idempotent commands и reconnect.** Повтор команды после timeout не должен повторять side effect. Server ledger и KMP `commandId` уже есть; нужна персистентная KMP outbox и UI для `UNKNOWN_AFTER_CRASH`.
5. **Human-in-the-loop.** Опасный tool call ставит run на паузу, решение должно быть адресуемым по call id, durable и разрешимым с другого клиента. TaskBridge это поддерживает; нужны audit trail и scoped allow policies.
6. **Tool isolation и policy.** Sandbox/worktree, allow/deny policy, ограничения path/network/process, secret redaction и размер output. Worktree и approval gate есть; остаются resource quotas и network policy.

### P1 — эксплуатация и качество

7. **Tracing/observability.** Иерархия task → agent → turn → model/tool spans, latency, tokens/cost, queue wait, retries, trace/group id и возможность не писать sensitive payload. Сейчас есть events/run ledger; нужен единый trace schema и экспорт.
8. **Tool/MCP lifecycle.** Capability negotiation, health, cancellation/progress, auth scopes, tool-name collisions, server/tool enable policy. Текущий MCP manager покрывает конфигурацию, но не health/OAuth/scopes.
9. **Context management.** Token budget, compaction checkpoints, input filtering/redaction, summary provenance и предупреждение до исчерпания context window. Manual/auto compact есть, но нет budget dashboard.
10. **Model routing/fallback.** Capability match (vision/reasoning/context), provider availability, retry classification, cost/balance guardrails и явное подтверждение дорогого fallback. Каталог и balances уже видимы; routing policy ещё не формализована.
11. **Evaluation.** Golden traces, deterministic fixtures, tool contract tests, replay, chaos и regression scoring. В проекте есть backend/KMP fixtures; добавить nightly replay и fault injection.

### P2 — масштабирование

12. **Multi-agent orchestration.** Handoff, agent-as-tool/subagent tree, bounded fan-out, cancellation propagation и суммарный budget. UI уже группирует subagent progress; нужен серверный parent/child run graph.
13. **Long-running tasks.** Checkpoints, pause/resume, background notifications, leases/heartbeats и orphan recovery. Частично реализовано через persisted Pi session и Android watch service.
14. **Security/audit administration.** OAuth scopes для remote MCP, credential isolation, consent, immutable audit and retention controls.

## План дальнейшей реализации

1. **P0 cache/outbox:** SQLDelight в `commonMain`; таблицы `sessions`, `events`, `cursors`, `commands`; атомарная запись input до сети; retry с тем же `commandId`; cache pruning.
2. **P0 scheduler hardening:** fair round-robin по session, per-provider quotas, workspace lease в persisted state, restart recovery tests, live `/api/info.scheduler` stream.
3. **P1 runtime dashboard:** DTO для `engine/system/local`, экран slots/load/unload/progress, подтверждение restart.
4. **P1 MCP v2:** health probe, last error/latency, OAuth state, scopes, add/edit server, validation до сохранения, audit событий изменения policy.
5. **P1 tracing/evals:** trace/group/span ids в событиях, sensitive-data flag, export JSON, golden replay и chaos matrix.
6. **P2 remote/cloud:** единый `TaskBridgeTransport` (LAN/relay), push wake-up, durable long-running task checkpoints.

## Критерии приёмки текущего этапа

- Две remote-сессии с разными workspace одновременно находятся в `RUNNING` и обе получают ответы.
- Вторая команда той же сессии не создаёт вторую генерацию, а идёт по queue/steer semantics.
- Две сессии одного non-worktree workspace не работают одновременно.
- Local-runtime sessions остаются capacity=1 независимо от общего лимита.
- KMP читает неизвестные дополнительные поля provider/MCP без падения.
- MCP toggle и provider refresh покрыты MockEngine API-тестом.
- Backend tests, KMP core tests, Android compile и Desktop package проходят; `dist/TaskBridge` содержит launcher, `app/` и `runtime/`.

## Фактическая проверка 2026-09-27

- `npm test`: 644 теста, 639 passed, 5 skipped, 0 failed.
- `npm run check`: синтаксис всех Node entry points и аудит секретов прошли.
- KMP core `:api:jvmTest :client:jvmTest` и shared `:shared:jvmTest`: успешно.
- Android `:androidApp:assembleDebug`: успешно.
- Desktop `:desktopApp:portable`: успешно; portable-каталог содержит 235 файлов.
- `dist/TaskBridge/TaskBridge.exe`: 461312 байт, SHA-256 `6D40046ED3769D41757AFA3C057B1F860D466A464FF7E4BF5B9ABD598B94E77E`.

## Первичные источники

- OpenAI Agents SDK: [Running agents](https://openai.github.io/openai-agents-js/guides/running-agents/) — cancellation, max turns, tool concurrency, guardrails и collision policy.
- OpenAI Agents SDK: [Sessions](https://openai.github.io/openai-agents-js/guides/sessions/) и [Human-in-the-loop](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/) — persistence, interruption и безопасное resume.
- OpenAI Agents SDK: [Tracing](https://openai.github.io/openai-agents-js/guides/tracing/) — task/agent/turn/model/tool spans и sensitive-data controls.
- OpenAI Agents SDK: [Agent orchestration](https://openai.github.io/openai-agents-js/guides/multi-agent/) — handoff и bounded parallel agents.
- MCP official SDK/spec mirror: [Lifecycle, transports, authorization and security](https://go.sdk.modelcontextprotocol.io/protocol/) — cancellation, progress, OAuth и transport security.
- MCP: [2026-07-28 specification release](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) — stateless core, Tasks extension, Apps и authorization hardening.
- Google ADK: [Development guide](https://google.github.io/agents-cli/guide/development/) — memory, sandboxed execution, approval gates, event-driven runs и evaluation workflow.
