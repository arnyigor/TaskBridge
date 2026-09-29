# Проверка ACP-подключения Claude / Codex — отчёт spike

Дата: 2026-09-24 · Машина: Windows 11, проект Taskbridge · Статус: исполнено живьём, не мок

## 1. Контекст

Вопрос: можно ли подключить TaskBridge (Server + KMP) к Claude Code и Codex, не только к Pi.
Анализ (внешняя модель, проверен по npm registry и GitHub) предлагал ACP-адаптеры как основу.
Этот spike проверяет ключевые сценарии исполнением на реальной машине.

Архитектура, под которую проверка:

```
KMP (Android/Desktop)
        │ WS/HTTP
        ▼
TaskBridge Server (Node)
        │
   AgentRuntime
        │
   ┌────┴─────────────┐
   ▼                  ▼
 Pi RPC         ACP adapter (stdio)
 (текущий)           │
   │            ┌────┴─────┐
   ▼            ▼          ▼
   Pi       Claude ACP   Codex ACP
```

Точка вставки в репозитории уже существует: `src/runners/pi-runner.mjs` определяет
`PiRunner` + `RunnerRegistry` (в комментарии прямо названо «later Claude/Codex»),
но модуль additive и в execution path не включён. `PiRpcSession` создаётся напрямую
в двух местах: `src/task-manager.mjs:923` и `src/model-catalog.mjs:81`.

## 2. Окружение

| Компонент | Версия | Примечание |
|---|---|---|
| Claude Code CLI | 2.1.245 | `C:\Users\ArnyPC\.local\bin\claude.exe`, **не залогинен** |
| Codex CLI | 0.156.1 (внутри адаптера), CLI-обёртка 0.120.0 | залогинен через ChatGPT (`~/.codex/auth.json`) |
| `@agentclientprotocol/claude-agent-acp` | 0.81.2 | npm, обновлён 2026-09-24 |
| `@agentclientprotocol/codex-acp` | 1.13.1 | npm, обновлён 2026-09-23 |
| `@agentclientprotocol/sdk` | 1.5.0 | npm, обновлён 2026-09-21 |
| Node | 24.16.0 | |

Проверенные версии npm-пакетов взяты из registry напрямую, не по памяти
(все ключевые совпали с анализом; `claude-agent-acp` уже 0.81.2, анализ называл 0.81.0).

## 3. Метод

Два spike-скрипта (в `tmp-debug/`, в проект не включены):

- `acp-claude-test.mjs` — полный сценарий: `initialize` → `session/new` →
  `session/prompt` («Reply with exactly: OK») → сбор `session/update`-событий →
  verdict CONNECTED/FAILED. Оба адаптера гоняются одним скриптом через
  `ACP_CMD` / `ACP_ARGS` env.
- `acp-codex-sessions.mjs` — чтение сессий: `session/list` → `session/load`.

Транспорт: stdio JSONL (JSON-RPC 2.0), spawn `npx -y <package>`, Windows.
Ключевые параметры ACP, подтверждённые ошибками и успеха:

- `initialize`: `{ protocolVersion: 1, clientCapabilities: { fs, terminal } }` —
  протокол-версия передаётся целым числом (1), не строкой.
- `session/prompt`: `{ sessionId, prompt: [{ type: 'text', text }] }` —
  массив называется `prompt` (не `content`; неверное имя даёт `-32602 Invalid params`).

## 4. Результаты: Codex — подтверждён целиком

Прогон 2026-09-24 19:52, `codex-acp@1.13.1` + Codex 0.156.1:

| Шаг | Результат | Детали |
|---|---|---|
| Старт адаптера | ✅ | npx, ~6 с на cold start |
| `initialize` | ✅ | protocolVersion = 1 |
| `session/new` | ✅ | реальный sessionId |
| `session/prompt` | ✅ | **реальный ответ `"OK"` за 4.6 с**, `stopReason: end_turn` |

Capabilities из живого initialize-ответа Codex:

```
loadSession: true
sessionCapabilities: resume, list, close, delete, fork, additionalDirectories, subagents
promptCapabilities: image, embeddedContext
mcpCapabilities: http (acp: false, sse: false)
authMethods: api-key, chat-gpt
```

### Чтение сессий (прогон 19:54)

- **`session/list`** ✅ — 25 реальных сессий с `sessionId`, `cwd`, `updatedAt`
  (проекты Taskbridge, ai-advent-challenge, `~/.pi` и др.).
- **`session/load`** ✅ — сессия восстановилась, адаптер вернул
  `availableModes` (`read-only` «Ask for approval», `agent` «Approve for me», …).
- **Напрямую с диска** ✅ — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`,
  обычный JSONL: `session_meta` (session_id, cwd, `model_provider: openai`,
  `cli_version: 0.156.1`) + сообщения по порядку. Сессии, созданные через
  адаптер, пишутся туда же (originator `@agentclientprotocol/codex-acp`).

## 5. Результаты: Claude — блокирован только аутентификацией

Прогон 2026-09-24 19:47, `claude-agent-acp@0.81.2`:

| Шаг | Результат | Детали |
|---|---|---|
| Старт адаптера | ✅ | |
| `initialize` | ✅ | protocolVersion = 1, `loadSession: true`, `sessionCapabilities: close, delete, fork`, promptCapabilities: image/embeddedContext, MCP http/sse |
| `session/new` | ✅ | реальный sessionId, Claude Agent SDK инициализируется за ~0.7 с |
| `session/prompt` | ❌ | `-32000 Authentication required` |

Причина — не адаптер, подтверждено независимо самим CLI:

```
> claude -p "Reply with exactly: OK"
Not logged in · Please run /login
```

Аутентификация на машине:

- `%USERPROFILE%\.claude\.credentials.json` содержит **только MCP OAuth-токены
  плагинов** (Linear, Atlassian, Slack, Asana, Monday) — это хранилище десктопного
  приложения. Токен основного аккаунта там не хранится.
- **Логин десктопного приложения и логин Claude Code CLI — разные хранилища
  и не разделяются** (проверено содержимым credentials.json).
- `ANTHROPIC_API_KEY` и `CLAUDE_CODE_OAUTH_TOKEN` в окружении не заданы.

Что нужно для завершения (один раз, интерактивно на ПК):

1. `claude` → `/login` (OAuth в браузере на ПК), либо
2. `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` в env (удобнее для сервера),
   либо `ANTHROPIC_API_KEY`.

Через телефон не работает: колбэк OAuth привязан к `localhost` ПК, где запущен CLI.
Проверка реального prompt/streaming/permission у Claude отложена до логина —
скрипт уже готов, добивает цепочку одной командой.

## 6. Поправки к внешнему анализу

| Утверждение анализа | Статус |
|---|---|
| `codex-acp` 1.13.1, Codex 0.156.1 | ✅ подтверждено (registry + rollout-файл) |
| `claude-agent-acp` 0.81.0 | ✏️ актуально 0.81.2 |
| `pi-acp` как равный вариант для Pi | ⚠️ пакет есть (0.0.33), но не обновлялся с 2026-07-30; для TaskBridge не нужен — native Pi RPC глубже |
| Capability-списки Codex (resume/list/fork/subagents/…) | ✅ подтверждено живым initialize |
| Capability-списки Claude (close/fork/loadSession/…) | ✅ подтверждено живым initialize (частично: `list` в ответе не видно, только в спецификации) |
| «Concurrent live ownership» невозможен | ⚠️ не проверялось — см. §7 |
| ACP Kotlin SDK — только JVM target | ✅ подтверждено (GitHub README / deepwiki) |
| Накопление `claude --resume` процессов, баги Codex Desktop | ❌ не проверялось |

## 7. Что осталось непроверенным (риски)

1. **Claude prompt/streaming/permission/stop** — после логина. Транспорт и
   session/new уже проходят; ожидается, что остальное пройдёт, но не доказано.
2. **Replay истории после `session/load`** — load вернул OK + modes, но сбор
   `session/update`-событий с восстановленными сообщениями не выполнялся.
3. **Concurrent live ownership** — подключение к сессии, которая прямо сейчас
   исполняется в Codex Desktop (возможен «thread already has an active writer»).
   Тестировалась только неактивная spike-сессия. Рекомендуемая модель — ownership:
   TaskBridge владеет сессией, возврат в Desktop через явный release, resume — да.
4. **Claude долгоживущий адаптер** — поведение при многократных reconnect+load
   (по анализу накапливаются дочерние процессы) — нужен watchdog в TaskBridge.
5. **Windows-специфика**: в spike spawn использовал `shell: true` (DEP0190
   deprecation warning) — в продакшн-коде TaskBridge адаптеры нужно запускать
   через `node dist/index.js` с явным путём, без shell.
6. **Одновременные 3 агента, restart TaskBridge, KMP disconnect/replay** —
   из acceptance-списка анализа не выполнялись (нужен Event Store в TaskBridge).

## 8. Вывод

- **Codex: интеграция доказана исполнением на этой машине** — handshake,
  управление сессиями, чтение сессий (ACP + диск), реальная генерация.
- **Claude: транспорт и управление сессиями работают**, генерация блокирована
  только аутентификацией CLI (не адаптера); завершение — один `/login` на ПК.
- **Архитектура подтверждена**: `AgentRuntime → ACP adapter (stdio) → Codex/Claude`
  работает тем же интерфейсом, что и текущий Pi RPC; точка вставки в репозитории
  (`RunnerRegistry`) уже готова. KMP не меняется; ACP-адаптеры живут на ПК в
  TaskBridge Server, телефон видит только унифицированные события сервера.
- **Единственное существенное ограничение**: не обещать «горячее одновременное
  подключение к сессии, исполняющейся прямо сейчас в Codex Desktop». Resume/handoff — да.

## Файлы

Spike-скрипты лежали в рабочем каталоге `tmp-debug/`, в проект не входили и удалены:

- `acp-claude-test.mjs` — полный сценарий (оба адаптера)
- `acp-codex-sessions.mjs` — session/list + session/load
