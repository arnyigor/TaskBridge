# Обзор и сравнение Pi-стека: референс из скриншота vs текущая конфигурация

Дата: 2026-09-19
Источник задачи: скриншот `.taskbridge-input/.../image.png` со списком `[Skills]` и `[Extensions]`
Предмет: выбрать лучшее из референсного набора и сравнить с текущим (пример: `pi-memory-md` vs мой MCP-инструмент памяти)

---

## TL;DR — вердикт

| # | Кандидат | Мой аналог | Вердикт | Приоритет |
|---|----------|-----------|---------|-----------|
| 1 | **pi-memory-md** | `manage_project_memory` (MCP mcpServer) | **Заменить** (с миграцией, не параллельно) | **P0** |
| 2 | **pi-rtk-optimizer** | `extensions/smart-compaction.ts` | ❌ **Отклонено пользователем** (2026-09-19) — берём другие улучшения | — |
| 3 | `memory-*` skills (из pi-memory-md) | — | Взять вместе с P0 | **P0** |
| 4 | `planning` / `review` / `test-driven-development` | проза в `AGENTS.md` | Взять как skills (разгрузка контекста) | **P2** |
| 5 | elpapi42/pi-minimal-subagent | `extensions/subagent` + `agents/*.md` | **Не брать** — дублирует, я богаче | — |
| 6 | pi-rlm | `scout → main → reviewer` цепочка | **Не брать** — плохо ложится на 1 GPU | — |
| 7 | herdr-agent-state.ts | `model-state` | **Сначала починить своё** | **P1 (bug)** |
| 8 | `graphify`, `memex-search`, `sa-s`, `dmc-1-tasks`, `change-request`, `ml-code-review` | — | **Не идентифицированы** — нужен источник | — |

---

## Метод и достоверность

**Проверено по первоисточникам** (npm registry + README из GitHub, прочитано сегодня):
`pi-memory-md@0.1.38`, `pi-rlm@0.1.3`, `pi-rtk-optimizer@0.9.0`, `elpapi42/pi-minimal-subagent` (GitHub API), а также содержимое моего локального стека.

**Не проверено / требует уточнения** (помечено в тексте как ⚠):
- источник и поведение `herdr-agent-state.ts` — репозиторий не найден;
- происхождение skills `change-request`, `dmc-1-tasks`, `graphify`, `memex-search`, `ml-code-review`, `sa-s`, `planning`, `review`, `test-driven-development` — ни один npm-пакет из найденных их не декларирует;
- работоспособность `pi-rtk-optimizer` на Windows — бинарник `rtk` в системе не установлен, поэтому rewrite-часть не проверена, проверена только декларация поддержки.

**Проверено исполнением:** скрипт миграции [scripts/import-persistent-memory.mjs](../scripts/import-persistent-memory.mjs) прогнан на реальных 10 срезах памяти. Результат: frontmatter валиден, legacy-заголовок «Срез от …» снят, содержимое перенесено **lossless — 10/10** (побайтовое сравнение тела без frontmatter), повторный запуск без `--force` идемпотентен (`written=0 skipped=10`), исходные файлы не изменены (сверено по sha256: копии совпадают с источником).

> ⚠ **Важно о статусе исходных заметок.** Ранее в этом отчёте я написал «`git status` чист» — это верно по неверной причине. Каталог `data/persistent_memory/` **игнорируется git** (`.gitignore:43` → `/data/`): `git ls-files` = 0, `git log -- data/persistent_memory/*` пуст. То есть **у заметок нет истории версий**, и моя формулировка была опасна — она читалась как «под гитом всё сохранено». Фактически защиты не было.

---

## Часть A. Что у меня сейчас (факты из файловой системы)

### Skills — `~/.pi/agent/skills/`
```
android-compose-ui     android-navigation         deepseek-to-files
android-data-layer     android-presentation-mvi   small-context-code-agent  ← SKILL.mdback (НЕ активен)
android-di-koin        android-testing
android-error-handling android-module-structure
```
Итого 8 доменных android-* + 1 `deepseek-to-files`. Один скилл (`small-context-code-agent`) лежит как `SKILL.mdback` — мёртвый груз.

### Extensions — `~/.pi/agent/extensions/`
```
bench-harness/     (ast-tool.ts, code-intercept.ts, index.ts, supervisor.ts)
model-state/       ⚠ только index.tsback + package.jsonback  → РАСШИРЕНИЕ НЕ ЗАГРУЖАЕТСЯ
readonly-tools/    index.ts
subagent/          (agents.ts, index.ts)
task-telemetry/    index.ts
smart-compaction.ts  (42 KB, лежит в корне extensions/)
context-router.tsback, state-runtime.tsback  ← мёртвые
```

### Packages — `settings.json`
```
npm:pi-mcp-adapter, npm:@plannotator/pi-extension, local-packages\pi-models-manager
```

### MCP — 15 серверов в `mcp.json`
Активны: `mcpServer`, `web-search`, `image-description-engine`, `artemis`, `deepseek-web`, `blender`, `qwen-web`.
Отключены: `serena`, `dependency-doctor`, `chrome-devtools`, `context7`, `tavily`, `clipboard-artifacts`, `project-md`, `figma-local`.
То есть **8 из 15 висят в конфиге отключёнными**. (В реестре отключённых есть ещё `markitdown` и `figma-local-copy`, но у них вообще нет записи в `mcp.json`.)

### Память — единственный механизм
Инструмент `manage_project_memory` в MCP `mcpServer` (`G:/AIModels/MCPs/McpServer/src/mcp_tools/core.py`).
Хранилище: `data/persistent_memory/*.md` — 10 тем: `blender, comfyui, habrrss, habrrss-devtests, hmm3ai, my-business, pi-app, pi-config, taskbridge, taskbridge_disk_cleanup`.

Устройство (проверено по коду):
- действия `save | load | list | delete`, тема задаётся вручную;
- лимит `MAX_MEMORY_TOKENS_LIMIT = 1500`;
- `MAX_ACTIVE_PROJECTS = 10` и **`_enforce_storage_limits()` вызывается на `core.py:173` (ветка save)** — при превышении лимита **самые старые файлы памяти удаляются безвозвратно** (`old_file.unlink()`);
- доставка в контекст — только по явному вызову `load`; авто-инъекции в начале сессии нет;
- поиска нет; git-истории нет; разделения global/user нет.

---

## Часть B. Кандидаты со скриншота (факты из первоисточников)

### pi-memory-md 0.1.38 (VandeeFeng) — Letta-подобная память
- Git-backed markdown: память живёт в отдельном **git-репозитории**, есть полная история версий.
- **Автодоставка в сессию:** при старте делает `git pull` → сканирует `*.md` → строит **индекс (только description + tags, не контент)** → отдаёт его один раз за сессию (`message-append` по умолчанию, либо `system-prompt`). Полный текст LLM читает инструментами по необходимости.
- Инструменты: `memory_sync` (`pull|push|status`), `memory_search` (`query|grep|rg`), `memory_check`.
- Skills в комплекте: `memory-init`, `memory-import`, `memory-write`, `memory-digest` (последний — в контексте tape-режима).
- Слеш-команды: `/memory-refresh`, `/memory-check [max-lines]`.
- Структура: `global/` (USER.md, MEMORY.md, TASK.md) + `<project>/core/` + `<project>/notes/`.
- Формат файла: frontmatter `description`, `tags`, `created`, `updated`.
- **Безопасность (важно):** проектный `.pi/settings.json` намеренно **не может** переопределить `repoUrl`, `localPath`, `memoryDir`, sync-хуки — чтобы вредоносный репозиторий не увёл память на чужой remote.
- Tape mode помечен как experimental.
- ⚠ Свежесть: публикация npm от 2026-05-25, версия всё ещё 0.1.x — проект полу-заморожен. Для сравнения: `pi-memory-evolution@0.4.2` обновлялся 2026-09-19.

### pi-rtk-optimizer 0.9.0 (MasuRii)
Два независимых механизма:
1. **Rewrite**: переписывает `bash`-команды в `rtk`-эквиваленты (делегирует решение внешнему бинарю `rtk`, есть guard при его отсутствии).
2. **Compaction выходных данных инструментов** — многостадийный конвейер: ANSI-стриппинг → агрегация тестов → фильтр build-вывода → компактизация git → агрегация линтера → группировка grep/rg по файлам → фильтрация исходников (`none|minimal|aggressive`) → умное усечение (**80-строчные read сохраняются дословно**) → anchor-safe read compaction (сохраняет целые якоря редактирования) → жёсткий лимит.
Плюс `/rtk stats` (метрики экономии), TUI-настройки, явно заявленная поддержка Windows.
⚠ Бинарник `rtk` не установлен → rewrite-часть на моей машине работать не будет; ценна именно compaction-часть.

### pi-rlm 0.1.3 (manojlds)
Инструмент `rlm`: рекурсивная декомпозиция с ограничением глубины (planner → decompose → дети → synthesizer). Guardrails: `maxDepth`, `maxNodes`, `maxBranching`, детект циклов, `concurrency`. Бэкенды `sdk | cli | tmux`. Артефакты в `/tmp/pi-rlm-runs/<id>/{events.jsonl,tree.json,output.md}`.

### elpapi42/pi-minimal-subagent
GitHub API: 39★, без лицензии и без поля description, ветка `master`, ~89 KB, последний push 2026-05-08. README есть (прочитан).

Устройство (по README + дереву репозитория `src/{index,agents,runner,render,settings,types}.ts` + тесты):
- регистрирует **один** инструмент: `{ agent, task }`;
- агенты — Markdown с YAML-frontmatter (`name`, `description`, `model`, `extensions`, `skills`, `thinking`);
- грузятся из `~/.pi/agent/agents/*.md` и `.pi/agents/*.md` (проектные перекрывают пользовательские) — **та же конвенция, что у меня**;
- **явно не читает `tools`-frontmatter и не передаёт `--tools` детям** → изоляции прав нет by design;
- нет chain/pool/orchestrator-режимов: параллелизм — это несколько вызовов `subagent` в одном ходу;
- есть `extensions` (tri-state `null | [] | [...]`, управляет загрузкой расширений у детей) и `environment` (env-переменные для детей);
- есть каталог `.planning/` — видно дисциплинированный процесс разработки.

Рядом: `AgwaB/pi-subagent` («Minimal subagent runtime for Pi», 48★), `JerryAZR/pi-subagent-lite`.

---

## Часть C. Сравнения

### C1. Память: pi-memory-md vs мой `manage_project_memory` (ключевое)

| Критерий | мой `manage_project_memory` | `pi-memory-md` |
|---|---|---|
| Хранилище | .md | .md |
| **Доставка в контекст** | ❌ только вручную, по вызову `load` | ✅ индекс авто-инъекцией в начале сессии |
| **Версионирование** | ❌ нет | ✅ git, полная история |
| **Риск потери данных** | 🔴 **есть: авто-`unlink()` старейших при >10 тем** | ✅ нет (git + ручные операции) |
| Поиск | ❌ нет | ✅ `memory_search` (query/grep/rg) |
| Скоуп | только проекты | global/user + проекты |
| Структура | плоский список тем | `core/`, `notes/`, шаблоны USER/MEMORY/TASK |
| Инициализация/импорт | ❌ руками | ✅ skills `memory-init`, `memory-import`, `memory-write`, `memory-digest` |
| Синхронизация между машинами | ❌ | ✅ `memory_sync pull/push` |
| Стоимость контекста | вся запись, ≤1500 токенов | **индекс вместо контента** → заметно меньше |
| Зависимость | MCP `mcpServer` должен быть запущен | расширение Pi, работает всегда |

**Разбор по существу — это не «две реализации одного», а разные уровни:**

`manage_project_memory` реализует ровно одну из четырёх функций — *хранение*. Отсутствуют три остальные: **доставка** (нет авто-инъекции → память работает, только если я вспомнил вызвать `load`), **история** (нет git), **навигация** (нет поиска). Плюс `_enforce_storage_limits()` даёт скрытую деструктивную семантику: 11-я тема молча удаляет самую старую. Прямо сейчас их ровно 10 — то есть **следующий `save` новой темы удалит одну из существующих**. Это тихий data-loss, а не гипотетический.

Отдельно: мой лимит 1500 токенов на срез введён ради защиты контекста, но решает проблему не тем местом. `pi-memory-md` решает её правильнее — в контекст кладётся **индекс (description + tags)**, а полный текст читается по требованию. То есть у него лимит контекста соблюдён, но без потери информации; у меня — за счёт усечения.

**Вердикт: заменить `pi-memory-md` как основной механизм.** Мой инструмент понизить до роли legacy-импортёра и оставить read-only на время миграции. Запускать оба на запись нельзя — получится split-brain (две расходящиеся копии, поиск по одной, запись в другую).

Миграция: [import-persistent-memory.mjs](../scripts/import-persistent-memory.mjs) — конвертирует 10 текущих тем в формат frontmatter и раскладывает по `notes/`. Источники не удаляются. Скрипт не только написан, но и **прогнан на всех 10 реальных срезах**: lossless 10/10, идемпотентен, исходники не тронуты (детали в разделе «Метод»).

⚠ Отдельная находка при разборе: срез `pi-config.md` называется *«Pi: модель состояния (extension model-state)»* — то есть в моей же памяти тема заведена под расширение, которое сейчас физически отключено (см. C5). Косвенное подтверждение расхождения документации и состояния.

### C2. Output compaction: pi-rtk-optimizer vs `smart-compaction.ts` — ОТКЛОНЕНО
> **Решение пользователя (2026-09-19): не ставим.** Заменяем более дешёвыми улучшениями (чистка, разгрузка `AGENTS.md`). Раздел оставлен ниже как основание — если вернёмся к вопросу.

**Это не конкуренты, а разные слои.** Мой `smart-compaction.ts` (42 KB) работает с *историей диалога* (компактизация контекста). `pi-rtk-optimizer` работает с *выводом отдельных инструментов* (`bash`/`read`/`grep`) **до** попадания в контекст.

Контраргумент к установке: он тянет внешний бинарник `rtk`, которого в системе нет → ценна только compaction-часть, а её lossy-стадии могут портить anchor-формат `read` и ломать последующее редактирование.

Для моего профиля (локальная 27B с малым контекстом, см. `AGENTS.md`) это **самый высокий ROI из всего списка**: узкое место — именно сырой вывод `bash`/`grep`/`read`. Полезны конкретно стадии «search grouping», «smart truncation» (80-строчные read дословно — важно, чтобы не ломать якоря редактирования) и «anchor-safe read compaction».
⚠ Rewrite-часть зависит от внешнего `rtk`, которого нет → отключать. ⚠ Перед включением lossy-стадий (source filtering / read compaction) — проверить, что не портит anchor-формат read; в README прямо рекомендуется для аудита держать их выключенными.

### C3. pi-rlm vs моя цепочка `scout → main → reviewer`
`pi-rlm` даёт рекурсию как *инструмент* с ветвлением и concurrency. Мой `AGENTS.md` прямо фиксирует ограничение: **«Одна GPU: последовательные вызовы; без параллельных субагентов»**. Рекурсивная декомпозиция с `concurrency: 2` на одной GPU даст thrashing, а не ускорение. Дополнительно: он пишет артефакты в `/tmp/pi-rlm-runs/` — ⚠ на Windows-путь не проверено, и бэкенд `tmux` у меня недоступен.
**Вердикт: не брать.** Моя последовательная модель осознанная и лучше подходит железу.

### C4. elpapi42/pi-minimal-subagent vs мой `subagent`
Это **самый близкий** кандидат: тот же формат агентов (`agents/*.md` с frontmatter), та же одна точка входа. Но набор возможностей смещён в другую сторону:

| Возможность | мой `extensions/subagent` | `pi-minimal-subagent` |
|---|---|---|
| Агенты как `.md` + frontmatter | ✅ | ✅ |
| `model` / `skills` / `thinking` per-agent | ✅ | ✅ |
| **capability isolation** (scout без bash/write, reviewer без мутаций) | ✅ (`agents.ts` + `readonly-tools`) | ❌ **by design**: `tools`-frontmatter не читается, `--tools` не передаётся |
| **chain-режим** (`{previous}`) | ✅ | ❌ сознательно отсутствует |
| Управление расширениями детей (`extensions` tri-state) | ❌ | ✅ |
| Инъекция env-переменных детям (`environment`) | ❌ | ✅ |
| Лицензия / свежесть | свой код | нет лицензии, push 2026-05-08 |

**Вердикт: не брать как замену** — это обмен ровно тех двух свойств, на которых держится мой `AGENTS.md` (read-only у scout/reviewer, chain для fact-check), на два полезных, но второстепенных.
**Но стоит позаимствовать идеи:** `extensions` tri-state и `environment` — у моего расширения этого нет, а для детей это реально нужно (изоляция окружения). Это идея к реализации, а не повод менять пакет.

### C5. herdr-agent-state.ts vs мой `model-state` — найденный баг
`model-state` **фактически отключён**: в папке только `index.tsback` и `package.jsonback` (переименованы в `.back` → Pi их не подхватит). При этом `AGENTS.md` описывает его как работающий виджет и документирует `/modelstate`. **Документация расходится с реальностью.**
⚠ `herdr-agent-state.ts` мне идентифицировать не удалось (репозиторий не найден) — сравнивать не с чем.
**Вердикт: сначала восстановить `model-state`** (убрать суффикс `.back` или удалить расширение и убрать его из `AGENTS.md`), и только потом рассматривать второй виджет статуса. Ставить два виджета над редактором бессмысленно.

### C6. Skills
**Из `pi-memory-md`** (`memory-init`, `memory-import`, `memory-write`, `memory-digest`) — берутся автоматически вместе с P0. Мои `android-*` не конфликтуют: `pi` разрешает конфликт имён по приоритету *project → user → package*, мои user-skills выигрывают.

**Мои skills vs референс:**

| Мой | Референс | Вывод |
|---|---|---|
| 8× `android-*` | — | Уникальны, домен-специфичны. Держать. |
| `deepseek-to-files` | — | Уникален (протокол недоверенного кода от внешней LLM). Держать. |
| `small-context-code-agent` (`.mdback`) | — | Мёртвый груз — удалить. |
| — | `planning`, `review`, `test-driven-development` | **Взять.** Сейчас этот процесс живёт прозой в `AGENTS.md` и грузится в контекст **каждой** сессии. Skill грузится по требованию → прямая экономия контекста 27B-модели. |
| — | `memory-*` | Взять вместе с `pi-memory-md`. |
| — | `graphify`, `memex-search`, `sa-s`, `dmc-1-tasks`, `change-request`, `ml-code-review` | ⚠ **Провенанс не установлен.** Названия не соответствуют ни одному найденному пакету. Не брать до выяснения источника — иначе это непроверяемый код в системе агента. |

`ml-code-review` — единственный, чей смысл очевиден по имени (ревью ML-кода). Если основная работа не ML, ценность близка к нулю.

---

## Часть D. План действий (ранжировано)

### Статус выполнения
| Шаг | Статус |
|---|---|
| P0.0 — бэкап + контрольные суммы + коммит | ✅ **выполнено** (коммит `8270864`, 12 файлов, sha256 10/10 OK) |
| P0.1 — снять `_enforce_storage_limits()` | ✅ **выполнено и проверено** (247 тестов passed, заметки 10/10 целы) |
| P0.2–P0.4 — установка `pi-memory-md` + хранилище + миграция | ✅ **выполнено** (10 заметок в git-памяти, запушено) |
| P0.5 — включение в живой сессии (рестарт) | ⏸ **не проверено** — требует перезапуска Pi |
| P0.6 — переключить запись на новый механизм (A) | ✅ **выполнено и проверено** (`save` → `SAVE_DISABLED`, `load`/`list` работают, 247 tests passed) |
| P0.7 — зафиксировать договор в `AGENTS.md` | ✅ **выполнено** (секции памяти раньше не было вообще) |
| P1.7 — `pi-rtk-optimizer` | ❌ отклонено пользователем |
| P1.8 — `model-state` / `AGENTS.md` drift | ⏸ ожидает |
| P2 — skills, чистка | ⏸ ожидает |
### P0 — память (сейчас, пока не потеряны данные)
0. ✅ **Страховка — СДЕЛАНО.** Бэкап 10 заметок + `SHA256SUMS.txt` лежит в [.memory-backup-2026-09-19/](../.memory-backup-2026-09-19/), сверен по sha256 (10/10 OK) и **закоммичен** (`8270864`). Чужие 11 незакоммиченных файлов в коммит не попали.
1. Признать `_enforce_storage_limits()` риском. **Заменить деструктивную автоочистку на предупреждение.** Готовый патч: [docs/patch-memory-non-destructive.diff](patch-memory-non-destructive.diff).

   Что доказано экспериментом (12 файлов при лимите 10):
   | Код | Осталось файлов | Потеряно |
   |---|---|---|
   | старый | 10 | **2** |
   | новый | 12 | **0**, плюс предупреждение со списком старейших |

   **ПРИМЕНЕНО** (пользователем) и проверено со стороны агента:
   - `git apply -R --check` → проходит ⇒ в файле ровно патч, без посторонних правок;
   - все 3 части на месте, `unlink` в автоочистке отсутствует (осталось только в докстринге как описание старого поведения), явный `action='delete'` не тронут;
   - `py_compile` OK; `pytest tests/` → **247 passed**;
   - заметки целы: 10/10, sha256 совпадают с бэкапом.

   `git apply --check` из каталога `McpServer` → exit 0 (применяется чисто). Явный `action='delete'` (строка 188) не трогается — это осознанное действие пользователя.
2. Зафиксировать текущие 10 тем в git (страховка до миграции).
3. `pi install npm:pi-memory-md`, в **глобальный** `~/.pi/agent/settings.json` добавить блок `pi-memory-md` (не в проектный — намеренно).
4. `/skill:memory-init`.
5. Прогнать импортёр (см. Appendикс), затем `/memory-check` и визуально сверить 10 тем.
6. Оставить `manage_project_memory` только на чтение/как legacy; новую память писать исключительно в `pi-memory-md`.

### P1 — честность статуса
7. ~~`pi install npm:pi-rtk-optimizer`~~ — **отклонено пользователем**: не ставим.
8. Починить или удалить `model-state` и привести `AGENTS.md` в соответствие с фактическим состоянием.

### P2 — гигиена
9. Подключить `planning` / `review` / `test-driven-development` как skills; вычитать из `AGENTS.md` дублирующую прозу (она уже описана там и грузится всегда).
10. Удалить мёртвые файлы: `small-context-code-agent/SKILL.mdback`, `context-router.tsback`, `state-runtime.tsback`.
11. Ревизия MCP: 8 отключённых серверов из 15 + мусор кэша — `mcp-cache.json` (~197 KB) и **16 осиротевших `mcp-cache.json.*.tmp` на 2.4 MB** (замерено). Отключённые оставить, только если реально нужны «на будущее»; иначе убрать из `mcp.json`. Мусор кэша безопасно чистить в любом случае.

### Не делать
- Не ставить `pi-rlm` (1 GPU, concurrency).
- Не ставить `elpapi42/pi-minimal-subagent` (деградация capability isolation).
- Не ставить неидентифицированные skills.

---

## Часть E. Риски и trade-off'ы честно

1. **`pi-memory-md` полу-заморожен** (npm 2026-05-25, всё ещё 0.1.38) при активной альтернативе `pi-memory-evolution` (2026-09-19, но 0.4.2 и «ничего не настраивается» — меньше контроля). Миграция на `md` оправдана тем, что формат — **обычный markdown + git**, то есть переезд на любую другую реализацию потом стоит копейки. Это главный аргумент: ставка не на пакет, а на формат.
2. **Tape mode experimental** — не включать на первом этапе; базовый `message-append` предсказуемее.
3. **Дублирование записи** (оба механизма) — прямой путь к расхождению данных. Только один writer.
4. ~~**`pi-rtk-optimizer` lossy-стадии** могут испортить anchor-формат read~~ — снято вместе с отказом от пакета.
5. Один `git push/pull` памяти на старте сессии = сетевой вызов и потенциальное окно ошибок при старте.

---

## Appendix. Команды

```bash
# P0.1 — снять деструктивную автоочистку памяти
#   G:/AIModels/MCPs/McpServer/src/mcp_tools/core.py:173
#   закомментировать строку:  _enforce_storage_limits()

# P0.2 — страховка текущей памяти
#   (СДЕЛАНО: бэкап закоммичен как 8270864 в репо Taskbridge)

# P0.3 — установка (СДЕЛАНО)
pi install npm:pi-memory-md

# P0.5 — миграция моих 10 тем (СДЕЛАНО)
node scripts/import-persistent-memory.mjs --dry-run --out "C:/Users/ArnyPC/.pi/memory-md"
node scripts/import-persistent-memory.mjs --apply   --out "C:/Users/ArnyPC/.pi/memory-md"
```

Блок для `~/.pi/agent/settings.json` — **уже применён** (локальный вариант, без облака):
```json
{
  "pi-memory-md": {
    "repoUrl": "C:/Users/ArnyPC/.pi/memory-md-remote.git",
    "localPath": "C:/Users/ArnyPC/.pi/memory-md",
    "memoryDir": {
      "repoUrl": "C:/Users/ArnyPC/.pi/memory-md-remote.git",
      "localPath": "C:/Users/ArnyPC/.pi/memory-md"
    },
    "delivery": "message-append"
  }
}
```
`repoUrl` указывает на **локальный bare-репозиторий** `~/.pi/memory-md-remote.git` — полная git-семантика (push/pull/история) без облака. Переход на приватный GitHub = поменять `repoUrl` + `git remote set-url origin <url>`.

## Часть F. Что выяснилось при установке (факты из исходников)

1. **`repoUrl` опционален для рантайма, но обязателен для `memory-init`.** `types.ts:56` → `repoUrl?: string`; `index.ts:420` → `if (!settings.repoUrl) return;` (нет URL — просто не синкается). Но скрипт `skills/memory-init/scripts/memory-init.sh` валится с `exit 1` при пустом `repoUrl`, и он же требует `jq`/bash.
2. **`jq` на машине нет** → инициализацию сделал вручную ровно те же шаги (clone + mkdir), без скрипта.
3. **`nodejieba` грузится лениво** (`bm25.ts:41` → `jiebaCutPromise ??= import("nodejieba")`), нативный бинарь собран и грузится — проверено запуском. Расширение не сломается.
4. **Сканирование рекурсивное** (`listMemoryFilesAsync` → `walkDir`), поэтому раскладка `notes/*.md` подхватывается.
5. **Имя папки проекта = `basename(git rev-parse --show-toplevel)`** (`memory-core.ts:222`), т.е. `Taskbridge` с большой буквы. Мои папки в нижнем регистре — на Windows (регистронезависимая ФС) резолвится; **на Linux это сломается**. Помечено как технический долг.
6. ⚠ **`pi-memory-md` добавил уязвимость в supply chain.** Через `nodejieba → @mapbox/node-pre-gyp → tar@6.2.1` пришла **CRITICAL** (`node-tar`: arbitrary file creation/overwrite via hardlink path traversal) + HIGH (`@mapbox/node-pre-gyp`). Атрибуция проверена через `npm ls`. Для сравнения: `fast-uri` и `smol-toml` (HIGH) — предсуществующие, от `pi-mcp-adapter`, не мои. Риск ограничен install-time (tar нужен node-pre-gyp для скачивания бинаря, в рантайм-пути памяти не участвует), но факт зафиксирован.
7. Пакет тянет нативную зависимость и 72 пакета ради markdown-памяти — это заметно больше, чем ожидалось от «markdown files in a git repository».

**Проверено end-to-end:** `getMemoryDir()` для текущего проекта → `C:\Users\ArnyPC\.pi\memory-md\Taskbridge` → `existsSync: true`; рекурсивный обход нашёл **2** заметки; frontmatter распарсился реальным `gray-matter` (description/tags/created корректны).

**НЕ проверено:** фактическая загрузка расширения и инъекция индекса в сессию — нужен перезапуск Pi.

## Часть G. Вариант A — переключение записи (выполнено)

**Найден корень проблемы:** `AGENTS.md` **вообще не упоминал память** — ни `manage_project_memory`, ни иного. Инструмент жил только в списке MCP-инструментов, то есть память работала, только если модель случайно вспомнит о нём. Договор надо было зафиксировать явно.

Сделано:
1. **`AGENTS.md` — новая секция «Память (единственный источник правды)»** (+1080 символов ≈ 327 токенов/сессия): где живёт память, формат frontmatter, `memory-write`/`memory-import`/`memory-digest`, `/memory-refresh`, `/memory-check`.
2. **`save` заблокирован на уровне сервера** ([patch-memory-readonly.diff](patch-memory-readonly.diff)): возвращает `error.code = SAVE_DISABLED` с указанием, куда писать. `load`/`list`/`delete` не тронуты.
3. Старая реализация `save` оставлена ниже как `if False:` — недостижима, но видна для истории (плюс целиком есть в git-истории `McpServer`).

Проверено вызовом реальной функции:

| action | результат |
|---|---|
| `save` | `SAVE_DISABLED`, **файл не создан** (мусорного `zzz_test_probe.md` нет) |
| `list` | 10 тем |
| `load taskbridge` | отдаёт `topic/tokens_used/memory_content/instructions` |
| `delete` | не тронут (осознанное действие пользователя) |

`pytest tests/` → **247 passed**. Договор закрыт кодом, а не надеждой: даже если будущая сессия забудет новый порядок, записать в старое хранилище физически нельзя.
