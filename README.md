# TaskBridge MVP — Pi remote control over local Wi‑Fi

Это **рабочий proof-of-concept**, цель которого — быстро проверить главную идею:

```text
Телефон → Wi‑Fi → TaskBridge → Pi RPC → выбранная модель → проект
                         ↓
                 live events / STOP /
                 follow-up / compact
```

Это ещё не production-версия из полного ТЗ. Здесь намеренно нет OpenClaw, Claude/Codex adapters, AUTO-router и сложной авторизации.

## Что уже работает

- локальный HTTP UI для телефона;
- PWA без внешних библиотек/CDN;
- список зарегистрированных проектов;
- Scratch workspace без проекта;
- текстовая задача;
- небольшие вложения с телефона (base64 JSON, для PoC);
- отдельный Git worktree для зарегистрированного Git-проекта;
- запуск `pi --mode rpc` в правильном `cwd`;
- строгий LF-JSONL parser для Pi RPC;
- live Pi events через SSE;
- tool start/end на телефоне;
- streaming assistant output;
- `STOP` через RPC `clear_queue` + `abort`, с fallback на kill process tree;
- follow-up / steering в живую Pi session;
- `COMPACT` через Pi RPC;
- compaction statistics (`tokensBefore`, `estimatedTokensAfter`), когда Pi их возвращает;
- Pi `get_state`;
- базовая persistent history на диске;
- `git status`, `git diff`;
- project-specific verification commands;
- `result.md`, `result.json`, `diff.patch`, Pi events и raw logs.

## Что намеренно НЕ входит

- SQLite (для PoC используется файловое persistent-хранилище);
- подключение к прежнему OS-процессу Pi (вместо этого запускается новый процесс с сохранённой сессией);
- Claude Code / Codex direct adapters;
- AUTO / маленькая dispatcher LLM;
- KMP Android app;
- pairing/auth;
- интернет-доступ;
- автоматический merge/apply;
- полноценный upload больших архивов.

---

# 1. Требования

- Windows 10/11;
- Node.js 20+;
- Git, если проверяется Git-проект;
- Pi CLI в `PATH`;
- Pi уже должен уметь работать с нужной моделью;
- для локальной модели — работающий llama.cpp endpoint либо configured managed launch.

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

# 2. Сначала проверить Pi отдельно

Это важно: TaskBridge не должен одновременно отлаживать и Pi, и модель.

Из папки проекта:

```powershell
pi -p "Ответь только PI_OK"
```

Если это не работает, сначала настроить Pi/model provider.

Дополнительно в архиве есть RPC smoke test:

```powershell
npm run smoke:pi -- "G:\path\to\project"
```

Успешный конец:

```text
[smoke] PI_RPC_OK: agent_settled received
```

---

# 3. Настройка Pi для существующей локальной модели

TaskBridge **не вмешивается в model provider Pi**. Он запускает тот же Pi, который работает у вас вручную.

Самый простой вариант:

1. открыть `pi`;
2. настроить provider/model;
3. сохранить его как default;
4. убедиться, что `pi -p ...` работает;
5. оставить `config.pi.args` пустым.

Для Pi можно также явно передать CLI flags:

```json
"pi": {
  "command": "pi",
  "args": [
    "--provider", "YOUR_PROVIDER",
    "--model", "YOUR_MODEL",
    "--thinking", "medium"
  ]
}
```

Для обычного OpenAI-compatible single-model llama.cpp endpoint можно настроить custom provider в Pi (`~/.pi/agent/models.json`). Для llama.cpp router Pi также имеет встроенную настройку `/login llama.cpp`.

**Практический критерий:** если эта команда работает из нужной папки, TaskBridge должен использовать те же настройки:

```powershell
pi -p "Прочитай README проекта и ответь одной строкой"
```

---

# 4. Запуск TaskBridge

Распаковать архив, затем:

```powershell
start.cmd
```

При первом старте автоматически создаётся:

```text
config.json
```

Сервер напечатает примерно:

```text
TaskBridge MVP listening on 0.0.0.0:8787
Local: http://127.0.0.1:8787
LAN (Wi-Fi): http://192.168.1.42:8787
```

На телефоне в той же Wi‑Fi сети открыть LAN URL.

---

# 5. Самая быстрая проверка без проекта

В UI выбрать:

```text
Project: Scratch workspace
```

Задача:

```text
Создай файл hello.txt со строкой TaskBridge works. Затем прочитай его и сообщи результат.
```

Нажать `RUN`.

На телефоне должны появиться Pi events.

---

# 6. Добавление реального проекта

Открыть `config.json`:

```json
{
  "projects": [
    {
      "id": "my-project",
      "name": "My Project",
      "path": "G:\\Projects\\MyProject",
      "useWorktree": true,
      "verification": [
        ".\\gradlew.bat test --console=plain"
      ]
    }
  ]
}
```

После изменения перезапустить TaskBridge.

## Git worktree

По умолчанию AI **не работает прямо в основном checkout**.

TaskBridge создаёт:

```text
data/worktrees/<task-id>/
```

и запускает Pi там.

Исходный проект остаётся нетронутым.

По умолчанию dirty source repository блокируется:

```json
"workspace": {
  "requireCleanSource": true,
  "useGitWorktreeByDefault": true
}
```

Для теста можно отключить проверку, но это не рекомендуется.

---

# 7. Проверка live logs/events

На экране задачи отображаются события вроде:

```text
Pi started processing
tool: grep
tool: read
tool: edit
tool: powershell — .\gradlew.bat test
tool done: powershell
Pi settled
```

Полные Pi RPC события сохраняются:

```text
data/tasks/<task-id>/artifacts/pi-events.jsonl
```

Pi stderr:

```text
pi.stderr.log
```

---

# 8. STOP

Кнопка `STOP`:

1. очищает queued steering/follow-up;
2. отправляет Pi RPC `abort`;
3. ждёт остановки;
4. если RPC abort завис — убивает дерево Pi process;
5. сохраняет частичный Git diff;
6. задача получает `CANCELLED`.

То есть можно запустить долгий `gradlew` и остановить с телефона.

---

# 9. Follow-up / steering

Поле под кнопками позволяет отправить инструкцию:

```text
Не меняй публичный API. Сначала проверь CurrentBranchApplierGitTest.
```

В режиме `auto`:

- если Pi сейчас streaming — используется `steer`;
- если Pi idle — отправляется новый `prompt` в ту же живую session.

После завершения follow-up verification выполняется повторно.

---

# 10. Manual compaction

Нажать:

```text
COMPACT
```

TaskBridge отправит Pi RPC:

```json
{"type":"compact"}
```

Можно ввести дополнительные instructions.

Если Pi возвращает статистику, UI покажет примерно:

```text
1 · 51832 → 19416
```

Важно: `estimatedTokensAfter` — оценка Pi, а не точный provider token counter.

TaskBridge **не реализует собственное сжатие**.

---

# 11. Pi state

Кнопка:

```text
PI STATE
```

делает RPC `get_state`.

Можно увидеть:

- current model;
- thinking level;
- `isStreaming`;
- `isCompacting`;
- session id/file;
- auto compaction enabled;
- message count;
- pending message count.

Точный текущий размер контекста не выдумывается, если Pi его в `get_state` не отдаёт.

---

# 12. Проверка файлов с телефона

UI поддерживает небольшие файлы.

Они сохраняются в workspace:

```text
.taskbridge-input/
```

А к prompt автоматически добавляется список вложений.

В этой PoC версии upload идёт как base64 внутри JSON, поэтому для больших ZIP/проектов этот механизм **не использовать**.

Лимит body задаётся:

```json
"server": {
  "maxBodyMb": 25
}
```

Production-версия должна перейти на streaming multipart upload.

---

# 13. Local Runtime Manager

По умолчанию проверяется:

```text
http://127.0.0.1:8080/health
```

Если сервер уже работает:

```text
EXTERNAL_RUNNING
```

TaskBridge его не останавливает.

Можно включить managed launch:

```json
"localRuntime": {
  "healthUrl": "http://127.0.0.1:8080/health",
  "managed": {
    "enabled": true,
    "command": "G:\\AIModels\\llamacpp\\llama-server.exe",
    "args": [
      "-m", "G:\\AIModels\\model.gguf",
      "--host", "127.0.0.1",
      "--port", "8080",
      "-ngl", "all"
    ],
    "cwd": "G:\\AIModels\\llamacpp"
  }
}
```

Для первой проверки лучше оставить ваш обычный llama-server уже запущенным.

---

# 14. Artifacts

После выполнения доступны:

```text
result.md
result.json
diff.patch
git-status.txt
pi-events.jsonl
pi.stderr.log       (если был stderr)
verification.log    (если настроена verification)
runtime.log         (если TaskBridge запускал runtime)
```

---

# 15. Безопасность PoC

**В этой версии нет login/token.**

Это сделано сознательно, чтобы быстро проверить идею.

Использовать только:

- в доверенной домашней LAN;
- Windows Firewall profile = Private;
- не пробрасывать порт 8787 в интернет;
- не включать UPnP/port-forwarding для этого порта.

TaskBridge не имеет endpoint вида `/shell`, но Pi сам является coding agent и имеет файловые/shell tools внутри выбранного workspace.

---

# 16. Известные ограничения

1. Task store пока файловый, не SQLite.
2. После restart TaskBridge при следующем сообщении запускается новый Pi-процесс с тем же файлом сессии. Если файла Pi нет, история восстанавливается из событий TaskBridge, включая результаты инструментов.
3. TaskBridge помечает оборванные active tasks как `FAILED` с кодом `FAILED_RECOVERY`; их можно продолжить новым сообщением.
4. Одновременно рассчитан на одну активную inference-задачу.
5. Follow-up после restart сохраняет ID сессии и историю; автоматического повторного выполнения оборванного запроса нет.
6. Upload предназначен для небольших файлов.
7. Нет automatic worktree cleanup.
8. `diff.patch` не содержит содержимое новых untracked файлов; они перечисляются в `git-status.txt`.
9. Verification commands доверенные и читаются из локального `config.json`.
10. Claude Code и Codex ещё не подключены.

---

# 17. Что проверить для решения «идея работает или нет»

## Тест A — RPC

```powershell
npm run smoke:pi -- "G:\path\to\project"
```

PASS: приходит `agent_settled`.

## Тест B — телефон

Открыть PWA и отправить Scratch task.

PASS: events видны live.

## Тест C — tools

Попросить Pi прочитать и создать файл.

PASS: `tool_execution_start/end` видны на телефоне.

## Тест D — cancel

Запустить задачу с долгой командой, затем STOP.

PASS: задача становится `CANCELLED`, выполнение прекращается.

## Тест E — browser disconnect

Запустить задачу и закрыть браузер на телефоне.

PASS: выполнение продолжается; после открытия UI виден текущий/финальный status.

## Тест F — worktree

Запустить coding task на Git-проекте.

PASS: основной checkout не изменился, diff лежит в task artifacts.

## Тест G — compaction

На достаточно длинной session нажать COMPACT.

PASS: приходит `compaction_end`, stats видны в UI.

Если A–G проходят, архитектурная идея `Phone → TaskBridge → Pi` практически доказана.

---

# 18. Следующий этап после успешной проверки

Не переписывать MVP. Расширять его:

```text
1. SQLite
2. multipart streaming upload
3. worktree cleanup/apply
4. ClaudeCodeRunner
5. CodexRunner
6. engine health/quota mapping
7. AUTO dispatcher
8. KMP Android client
```

Главное — сначала проверить Pi RPC, live events и STOP на реальной локальной модели.
