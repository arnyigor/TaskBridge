# experiments/omp-01 — изолированная проверка Oh My Pi

Проверка OMP как альтернативного агентного ядра (OMP-01). Ничего в TaskBridge не
меняется: только чтение и запуск отдельного бинарника `omp`.

```
omp-rpc-client.mjs   минимальный клиент OMP RPC (ready, prompt_result, session_settled, rpc_chunk)
rpc-checks.mjs       13 проверок протокола (протокол, инструменты, steer/follow_up, abort, сессии, чанки)
run-functional.mjs   шесть сценариев: поиск, отсутствие, анализ, зависимости, две правки с тестами
fixtures/build.mjs   синтетический JS-проект с посаженной ошибкой и каталог курсов
```

Запуск:

```bash
node experiments/omp-01/rpc-checks.mjs --model deepseek-flash
node experiments/omp-01/run-functional.mjs --model deepseek-flash [--only D01,D02]
```

Изоляция: `--profile omp01` (свои agent-db/models-db, сессии, кэши) и
`--session-dir` внутри `.local/omp-01/`; ключ провайдера — из окружения
(`DEEPSEEK_API_KEY`). В репозиторий не попадают ни сессии, ни логи.

Выводы, версия и оценка стоимости интеграции — `docs/omp-01-feasibility.md`.
