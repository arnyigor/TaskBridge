# experiments/pi-hooks — PoC TASKBRIDGE-CORE-01

Изолированный эксперимент: применяются ли инструкции хода штатным Pi-хуком
`before_agent_start`, без правки пользовательского сообщения.

**Это не часть сборки.** Ничего из `src/` здесь не меняется; расширение только
импортирует классификатор профилей из `src/prompt-builder.mjs`.

```
turn-instructions.js   расширение: хук + команда /tb-profile
broken-extension.js    расширение, падающее в хуке (проверка ошибки)
run-poc.mjs            стенд: настоящий Pi в RPC, 7 сценариев, отчёт JSON
```

Запуск:

```bash
node experiments/pi-hooks/run-poc.mjs --model deepseek/deepseek-flash \
  --out .local/pi-hooks/$(date +%Y-%m-%d)
# отчёт: <out>/report.json, журнал хука: <out>/hook.jsonl
```

Логика самого PoC проверяется без Pi и без модели:
`node --test tests/pi-hooks-poc.test.mjs`.

Выводы и ограничения — `docs/pi-hooks-feasibility.md`.
