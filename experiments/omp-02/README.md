# experiments/omp-02 — Pi vs OMP на сложных правках кода

Этап OMP-02 из [Roadmap vNext](../../docs/ROADMAP_VNEXT_2026-10-21.md): доказать или
опровергнуть пользу OMP **на программировании**, а не на коротких демо-задачах.

Стенд ничего не меняет в рабочем TaskBridge: у каждого прогона свой каталог,
свой `--session-dir`, свой профиль OMP (`omp02-b`/`omp02-c`) и отдельный каталог
конфигурации Pi (`PI_CODING_AGENT_DIR`), чтобы глобальные правила пользователя не
влияли на сравнение.

```
run-comparison.mjs   прогон сценария одним ядром: запрос → снимок файлов → проверка
checks.mjs           проверка состояния среды (тесты, javac, отсутствие лишних правок)
checks/java/shop/Verify.java  проверочный класс CODE-01, кладётся ПОСЛЕ прогона
fixtures/build.mjs   сборка чистых копий CODE-01..CODE-04
fixtures/code-01-java  Java-проект магазина: 6 файлов, цены в double (рубли)
fixtures/code-02-node  Node.js-проект с ошибкой в корне (units → parse → pricing → report)
fixtures/code-04-node  Node.js-проект: 12 сервисов вызывают fetchUser(id)
```

CODE-03 (большой файл, точечная правка) генерируется в `fixtures/build.mjs`:
~4200 строк, 200 однотипных функций и общая `sliceWindow` с лишним элементом.

## Запуск

```bash
node experiments/omp-02/run-comparison.mjs --variant pi-a --only CODE-02
node experiments/omp-02/run-comparison.mjs --variant all --timeout 900000
```

Варианты:

| Вариант | Ядро | Инструменты |
| --- | --- | --- |
| `pi-a` | Pi 1.3.0 | `read,write,edit,bash,grep,find,ls`, без расширений/MCP/skills |
| `omp-b` | OMP 18.11.0 | `read,write,edit,bash,grep,glob`, `--no-lsp --no-pty` |
| `omp-c` | OMP 18.11.0 | штатный набор, включая LSP и PTY |

Модель и уровень thinking одинаковы во всех прогонах (`--model deepseek-flash --thinking high`),
ключ — из окружения (`DEEPSEEK_API_KEY`), в отчёт не попадает.

## Что собирается по каждому прогону

`run.json` и `summary.json` в `.local/omp-02/run-<timestamp>/` (вне Git):
`ok`, `status`, `settled`, `wallMs`, `firstActivityMs`, `toolCalls`, `toolNames`,
`repeatedCalls`, `errorCalls`, токены, `changedFiles`, `diffLines`, `stopReason`,
`eventTypes` и детали проверки.

Качество оценивается по состоянию среды, а не по рассказу агента: тесты фикстуры,
компиляция и запуск проверочного класса, отсутствие остатков старого API и
ограничение на размер правки там, где задача требует точечного изменения.
