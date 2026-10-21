# Baseline TaskBridge + агентное ядро (этап 0, TASKBRIDGE-CORE-01)

Снимок состояния **на 2026-10-21**, с которого начинаются эксперименты с ядром.
Документ фиксирует версии, конфигурацию и результаты проверок — чтобы через
неделю можно было отличить «стало лучше» от «было по-другому настроено».

## Локальные коммиты (не опубликованы)

| Коммит | Содержание |
| --- | --- |
| `3f49c18` | PromptBuilder, профили, `toolEvidence` |
| `4f42439` | Тесты профилей и границ доказательств |
| `af3f917` | Web UI для `toolEvidence` |
| `bea76f4` | Привязка поздней ошибки к ходу по `data.turn` |
| `709826a` | Бенчмарк `bench/agent-behavior` (MR-05) |
| `ca3c0f0` | Разрешение `experiments/` в allowlist репозитория |

Ветка `master`, база — `3662945` (release 1.3.0).

## Версии

| Компонент | Значение |
| --- | --- |
| TaskBridge | 1.3.0, запущенный с коммита `3662945` (`GET /api/info → build`) |
| Pi (`@earendil-works/pi-coding-agent`) | **1.3.0**, `C:\Users\ArnyPC\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent` |
| Node.js | v24.16.0 |
| npm | 11.13.0 |
| ОС | Windows, git-bash |

`GET /api/info` сообщает `pi.supported: false` при диапазоне `>=0.85.0 <1.1.0`:
эвристика поддержки в TaskBridge отстала от установленной версии 1.3.0. На работу
это не влияет (сессии идут), но объясняет, почему «версия Pi» в интерфейсе
выглядит неподтверждённой.

## Конфигурация (что реально запущено)

| Параметр | Значение |
| --- | --- |
| `server.host:port` | `0.0.0.0:8787`, TLS на `8443` |
| `server.auth.enabled` | `true` (устройства сопряжены, локальный loopback считается доверенным) |
| `pi.command` / `args` | `pi`, без дополнительных аргументов |
| `pi.mcp.mode` | `managed` |
| `pi.projectTrust` | `approve` |
| `localRuntime.provider` | `llama.cpp` (Strata-роутер, `http://127.0.0.1:8080`) |
| Модель по умолчанию (`GET /api/models`) | `strata/qwen3.8-flash-next-iq3_s`, окно 204 800, thinking `medium` |
| Каталог моделей | 1103 записи (локальные + облачные провайдеры) |
| Проектов | 33 |

Локальный Strata-роутер отвечает: `GET /v1/models` → `qwen-27b-q3` (статус
`unloaded`, веса грузятся по требованию).

## Незакоммиченные изменения (не трогать)

```
 M clients/kmp/shared/src/commonMain/kotlin/ru/arny/taskbridge/ui/chat/ChatItems.kt
 M clients/kmp/shared/src/commonMain/kotlin/ru/arny/taskbridge/ui/chat/ChatScreen.kt
 M clients/kmp/shared/src/commonMain/kotlin/ru/arny/taskbridge/ui/chat/MarkdownView.kt
 M clients/kmp/shared/src/commonMain/kotlin/ru/arny/taskbridge/ui/theme/Theme.kt
?? clients/kmp/shared/src/jvmTest/kotlin/ru/arny/taskbridge/ui/chat/CodeChipRenderTest.kt
?? pi-deliveries.ndjson
```

Это работа оператора над KMP-клиентом. Эксперименты с ядром её не касаются; ни
`git add -A`, ни `git reset --hard`, ни чистка каталога не выполнялись.

## Результаты проверок на этом снимке

| Проверка | Результат |
| --- | --- |
| `npm test` | **1267 тестов: 1263 pass, 4 skip, 0 fail** (~2 мин) |
| `node scripts/regression-suite.mjs server chat` | 2/2 секции зелёные |
| `npm run check` | exit 0 (в цепочке `node --check` для сервера, клиента, бенчмарка и `check-secrets`) |
| `npm run check:policy` | «every path and every added line has a right to be here» |

Skip — прежние, по условиям среды: cloud-DOM-тест, postgres без
`TASKBRIDGE_TEST_DATABASE_URL`, «killing Pi also kills the processes»
(на Windows покрыто `taskkill /T`), «missing Pi behind a shell» (POSIX-скрипт).

## Изоляция экспериментов

Для PoC и сравнений ядро поднимается со своим каталогом состояния:

- `PI_CODING_AGENT_DIR=<свой каталог>` — Pi читает настройки/расширения/credentials
  из него. Ключи провайдеров берутся из окружения (`DEEPSEEK_API_KEY` и т.п.),
  поэтому чужие `auth.json` не копируются.
- `TASKBRIDGE_DATA_DIR=<свой каталог>` — TaskBridge не читает `data/` оператора.
- Отдельный `git worktree` на нужном коммите — для варианта «код до правки»
  (так сделан смоук A/B в `bench/agent-behavior`).

Замечено расхождение, которое стоит держать в голове: TaskBridge в
`src/pi-settings.mjs` ищет каталог агента по `PI_AGENT_DIR`, а Pi 1.3.0 читает
`PI_CODING_AGENT_DIR`. Первое имя ни на что не влияет (переменная просто не
найдётся и будет взят `~/.pi/agent`). Исправление — отдельная задача, в этом
эксперименте не делалось.

## Что в этот снимок НЕ входит

- Полный A/B-прогон `bench/agent-behavior` (96 запусков): выполнены только смоуки
  (A: 2 сценария, B: 3) — они проверяют стенд, а не гипотезу.
- Сравнение с OMP: OMP не устанавливался и не запускался.
- Локальная Qwen: в экспериментах не участвовала (использован `deepseek-flash`,
  чтобы не тратить минуты на загрузку весов и не смешивать механику хука с
  поведением конкретной модели).
