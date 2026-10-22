# experiments/pi-hooks — PoC TASKBRIDGE-CORE-01

Изолированный эксперимент: применяются ли инструкции хода штатным Pi-хуком
`before_agent_start`, без правки пользовательского сообщения.

**Это не часть сборки.** Ничего из `src/` здесь не меняется; расширение только
импортирует классификатор профилей из `src/prompt-builder.mjs`.

```
turn-instructions.js   расширение: хук + команда /tb-profile
broken-extension.js    расширение, падающее в хуке (проверка ошибки)
run-poc.mjs            стенд: настоящий Pi в RPC, 7 сценариев, отчёт JSON
follow-plan-compat.mjs стенд FP-00: extension-tool, turn_end/agent_before_settle,
                       abort (STOP) и очередь на реальном Pi 1.4.0
follow-plan-checkpoint-fixture.js  fixture-расширение для этого стенда
```

Запуск:

```bash
node experiments/pi-hooks/run-poc.mjs --model deepseek/deepseek-flash \
  --out .local/pi-hooks/$(date +%Y-%m-%d)
# отчёт: <out>/report.json, журнал хука: <out>/hook.jsonl
```

Логика самого PoC и production-расширения проверяется без Pi и без модели:
`node --test tests/pi-hooks-poc.test.mjs`.

Стенд умеет прогонять ЛЮБОЕ расширение (`--extension`) — так проверено
production-расширение `pi-extension/taskbridge-turn-instructions.js`:

```bash
MSYS_NO_PATHCONV=1 node experiments/pi-hooks/run-poc.mjs   --extension pi-extension/taskbridge-turn-instructions.js --skip-slash   --model deepseek/deepseek-flash --out .local/core02/poc
```

`--skip-slash` нужен потому, что production-расширение не регистрирует свою
команду; сценарий «команда» проверяется запуском PoC-расширения. `MSYS_NO_PATHCONV=1`
— чтобы git-bash не превращал `/compact` в `C:/Program Files/Git/compact`.

Интеграционная проверка через сам TaskBridge (пять ходов, смена профиля, сравнение
`legacy` и `hook`):

```bash
node experiments/pi-hooks/integration-check.mjs --mode hook   --model deepseek/deepseek-flash
node experiments/pi-hooks/integration-check.mjs --mode legacy --model deepseek/deepseek-flash
# провайдеры, объявленные в models.json оператора (например `strata`), требуют
# его каталога агента: --operator-agent-dir
```

Каждый прогон пишет `<out>/report.json` и `<out>/server.log`; каталог данных,
`config.json` и agent-dir создаются внутри `<out>`, операторские не читаются.

Выводы и ограничения — `docs/pi-hooks-feasibility.md`.

Поверхность Follow Plan (extension-tool, `turn_end`, `agent_before_settle`,
`agent_settled.aborted`, очередь, STOP) на Pi 1.4.0:

```bash
node experiments/pi-hooks/follow-plan-compat.mjs --model deepseek/deepseek-flash --out .local/fp-00/run3
```

Контракт и результаты — `docs/follow-plan-pi-1.4.0-contract.md`.

Любое расширение проверяется тем же стендом через `--extension`; проверки журнала
хуков и контрольного хода относятся только к fixture и в этом случае пропускаются:

```bash
MSYS_NO_PATHCONV=1 node experiments/pi-hooks/follow-plan-compat.mjs   --extension pi-extension/taskbridge-follow-plan.js --model deepseek/deepseek-flash --out .local/fp-02/prod
```
