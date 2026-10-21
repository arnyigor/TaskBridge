# BASE-01 — зафиксированная база перед Roadmap vNext

**Дата:** 21 октября 2026
**Ветка:** `master`, HEAD `1013660` (`v1.3.0-20-g1013660`)
**Смысл этапа:** зафиксировать, с чего начинается roadmap, и не менять ничего работающего.
Источник плана — [ROADMAP_VNEXT_2026-10-21.md](ROADMAP_VNEXT_2026-10-21.md), этап BASE-01.

## 1. Версии и состояние репозитория

| Параметр | Значение |
| --- | --- |
| Node.js | 24.16.0 |
| npm | 11.13.0 |
| Pi | 1.3.0 |
| OMP | `omp/18.11.0` |
| git | 2.55.0.windows.5 |
| `git status --short` | только `?? pi-deliveries.ndjson` (не трогаем, в `.gitignore` не входит) |
| Незакоммиченные правки KMP | отсутствуют в `master` на момент снятия baseline |

Локальная конфигурация провайдеров (`~/.pi/agent/models.json`): **10 провайдеров, 552 модели**.
Имена и ключи в репозиторий не выгружаются: там могут быть корпоративные endpoint'ы.
В отчёт попадает только количественная сводка.

## 2. Гейты на текущем HEAD

| Гейт | Команда | Результат |
| --- | --- | --- |
| Тесты | `npm test` | ✅ 1291 тест, 1287 pass, 0 fail, 104 с (4 пропуска — штатные `skip`) |
| Синтаксис и секреты | `npm run check` | ✅ exit 0, «no secret would leave this machine» |
| Политика репозитория | `npm run check:policy` | ✅ exit 0, 0 staged, 4 локальных запрещённых термина у `security.local.json` |

Логи прогонов: `.local/base-01-test.log`, `.local/base-01-check.log`, `.local/base-01-policy.log` (вне Git).

## 3. Что подтверждено по коду

- **CORE-02 (per-turn инструкции).** `src/task-manager.mjs` подключает расширения к Pi через `-e`:
  approval-расширение (строка 2986), `taskbridge-turn-instructions` (3010), media-расширение (3023).
  То есть hook `before_agent_start` обслуживает новые Pi-сессии; история старых сессий не переписывается.
- **TB-STAB-01 / корреляция 502.** `x-taskbridge-request-id` проставляется в прокси
  (`src/proxy.mjs:41,59,82`), попадает в лог ошибок сервера (`src/server.mjs:2534`) и покрыт
  тестом `tests/proxy.test.mjs` (заголовок доходит до upstream и возвращается клиенту).
  Сам редкий STOP-502 **не воспроизведён и не считается исправленным** — как и записано в roadmap.

## 4. Карта существующих endpoint'ов и экранов (чтобы не плодить аналоги)

| Область | API | UI |
| --- | --- | --- |
| Каталог моделей | `GET /api/models` | model picker в `web/index.html`, `ModelPicker` в KMP |
| Проба модели | `POST /api/models/probe` | кнопка проверки в Web-редакторе провайдеров |
| Профили провайдеров | `GET/POST /api/provider-profiles` | `web/providers.html` |
| Обновление статуса | `POST /api/providers/refresh` | статус провайдера в `web/providers.html` |
| Локальные модели (llama.cpp/Strata) | `/api/local`, `/api/local/start|stop|load|unload|context|vision|events` | `LocalModelsScreen.kt`, `SettingsScreen.kt` |
| Библиотека GGUF | `/api/library`, `/api/library/scan|register|run|delete|forget` | экран локальных моделей |
| Загрузки HF | `/api/hf/search|repo|download|downloads|cancel|retry|clear` | экран локальных моделей |
| Runtime Pi | `/api/runtime`, `/api/runtime/start|restart` | настройки Web/KMP |

Модули-источники (уже существуют, второй реестр не создаём):
`src/providers/pi-provider-profiles.mjs`, `src/model-catalog.mjs`, `src/model-probe.mjs`,
`src/provider-models.mjs`, `src/provider-status.mjs`, `src/local-models.mjs`.

## 5. Границы, принятые на этом шаге

- Рабочий TaskBridge, его `config.json`, `data/`, Pi-расширения и активные сессии не изменялись.
- `pi-deliveries.ndjson` не тронут.
- Экспериментальные стенды (OMP-01/OMP-02) запускаются в отдельных каталогах `.local/`,
  с отдельными `--session-dir` и отдельным профилем OMP; у Pi на время прогонов
  подменяется каталог конфигурации через `PI_CODING_AGENT_DIR`, чтобы глобальные
  правила пользователя не влияли на сравнение.
