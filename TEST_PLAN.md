# TaskBridge MVP — быстрый план проверки

## 1. Pi RPC напрямую

```powershell
npm run smoke:pi -- "G:\path\to\project"
```

Ожидание: `PI_RPC_OK: agent_settled received`.

## 2. Запуск сервера

```powershell
start.cmd
```

Открыть напечатанный LAN URL на Android.

## 3. Scratch test

Prompt:

```text
Создай hello.txt со строкой TASKBRIDGE_OK. Прочитай файл обратно и сообщи результат.
```

Проверить live events и `SUCCEEDED`.

## 4. Cancel test

Попросить Pi выполнить безопасную долгую команду/долгий test, затем нажать STOP.

Ожидание: `CANCELLED`, Pi перестал выполнять текущий run.

## 5. Follow-up test

Во время работы отправить:

```text
Не меняй никакие файлы. Только заверши анализ и подведи итог.
```

Ожидание: инструкция попадёт через steer.

## 6. Worktree test

Добавить clean Git project в `config.json`, `useWorktree=true`.

Попросить изменить один файл.

Проверить:

- основной checkout не изменился;
- `data/worktrees/<task-id>` содержит изменения;
- `diff.patch` создан.

## 7. Compaction test

На живой длинной session нажать COMPACT.

Ожидание: `compaction_end`, до/после отражены в UI.

---

Подробный план проверки бэкенда (автотесты, приёмка изменений, запись RPC-транскриптов, chaos, soak, форма отчёта) — [docs/TEST_PLAN_BACKEND.md](docs/TEST_PLAN_BACKEND.md).
