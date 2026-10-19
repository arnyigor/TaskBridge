# TaskBridge — Resource Cleanup Manager (план)

Источник: ТЗ v1.0 от 2026-10-12 (экран «Процессы машины» → «Ресурсы и очистка»).
Полное ТЗ хранится в истории задачи; здесь — рабочий план по MR с критериями.

## Цель
Превратить экран процессов в инструмент контролируемого освобождения RAM/VRAM
перед запуском локальных LLM. Массовая очистка не должна завершать TaskBridge,
активные сессии, текущую модель, системные службы, приложения с несохранённой работой.

## Этапы

### PROC-01 — Correct Resource Metrics (P0)
- [x] Системная RAM: total/free/used из ОС (не сумма WorkingSet процессов).
- [x] GPU-агрегат через `nvidia-smi --query-gpu` (имя, total/used/free VRAM, utilization),
      с `sampledAt` и источником.
- [x] `N/A` от nvidia-smi → `null`, никогда не 0.
- [x] `GET /api/system/resources` — агрегированный snapshot.
- [x] Тесты парсинга Windows/NVIDIA + контракт эндпоинта.
Критерий: «N/A» никогда не показывается как «GPU свободна».

### PROC-02 — Process Identity & Protection (P0)
- [x] parentPid в snapshot (Windows WMI + ps), дерево процессов (`descendantsOf`, защита от циклов).
- [x] Проверка КАЖДОГО потомка перед tree-kill: защищённый потомок отказывает весь kill (код PROTECTED + protectedPid в ответе ошибки).
- [x] `findProtection` — единые правила (self-pid, системные имена, командные строки TaskBridge) для цели и потомков.
- [x] Тесты: дерево/циклы, отказ при защищённом потомке (живой процесс-фикстура), разрешённый tree-kill.
Критерий: массовая операция не может завершить защищённый процесс через родителя. ✔

### PROC-03 — Compact UI & Groups (P1)
- [x] Экран переименован в «Ресурсы и очистка», шапка RAM/GPU из /api/system/resources.
- [x] LazyColumn с key=pid, компактные строки, разворачиваемые детали (команда, родитель, старт).
- [x] Поиск (имя/команда/pid), фильтры Все/GPU/Node/Python/Java, сортировка по RAM.
- [x] Мультивыбор + «Остановить выбранные» (последовательные /kill, защита сервера действует).
- [x] KMP: ProcessEntry.parentPid, ResourceSnapshot/RamSnapshot/GpuSummary/GpuCard, TaskBridgeApi.systemResources().
- [x] KMP: кнопка «Освободить GPU» — `cleanupPreview(objective=gpu, pids текущих GPU-процессов)` → диалог с кандидатами → `cleanupExecute`; итог показывает счётчики и VRAM до/после. PID присылаются явно: GPU-цель без pids предложила бы все Node/Python/Java.
Критерий «500 процессов» замером не проверялся — виртуализация обеспечена LazyColumn с ключами; runtime-UI-тест не запускался.

### PROC-04 — Cleanup Preview & Batch API (P1)
- [x] `POST /api/system/cleanup/preview` → planId, TTL 60 с, snapshot revision, кандидаты, protected/skipped, warnings, estimatedRamBytes.
- [x] `POST /api/system/cleanup/execute` (confirm:true, local-only, plan одноразовый, commandId идемпотентен).
- [x] `GET /api/system/cleanup/:commandId`; `GET /api/system/cleanup/history` (только счётчики, без командных строк).
- [x] Частичные результаты STOPPED/ALREADY_EXITED/PROTECTED/IDENTITY_CHANGED/FAILED; RAM до/после + наблюдаемая дельта; GPU used до/после.
- [x] Тесты tests/cleanup.test.mjs (4 pass): ranking, e2e preview→execute→retry, отказы, PROTECTED per-process.
Критерий выполнен.

### PROC-05 — Profiles & Recommendations (P1)
- [x] Детерминированный ranking в preview (objective ram|gpu): accounted RAM + GPU-флаг, runtime-группы (node/python/java), без LLM.
- [x] Защищённые исключаются на этапе плана; предупреждения «оценка ≠ обещание», предупреждение про WDDM VRAM.
- [ ] Правила исключений пользователя (по приложению/пути) — НЕ сделано.
- [ ] Custom Profile (сохранение правил) — НЕ сделано.

### PROC-06 — Prepare for Local LLM (P2)
- [x] targetFreeRamBytes в preview: предупреждение о дефиците RAM.
- [ ] Интеграция с менеджером моделей (требования модели, штатная выгрузка через LocalModelService) — НЕ сделано.

### PROC-07 — Remote Control & Polish (P2)
- [x] execute cleanup разрешён только локально (access.enabled && !access.local → 403); просмотр ресурсов — без ограничения.
- [x] Audit: history со счётчиками, без командных строк.
- [ ] Отдельное разрешение удалённого cleanup на устройстве, UX Android/Desktop — НЕ сделано.

## Ключевые решения (из ТЗ)
- Не обещать точный эффект: «суммарное учтённое потребление X», факт — измерение после.
- Per-process VRAM под WDDM недостоверна → главный критерий очистки GPU — изменение
  глобально занятой dedicated VRAM.
- Identity процессов: pid + startedAt (+ путь, команда), не только pid.
- Старые маршруты `/api/processes*` сохраняются.

## DoD (кратко)
Корректные агрегированные RAM/GPU; null вместо 0; очистка через подтверждённый план;
защищённые недостижимы ни напрямую, ни через дерево; без регрессий существующего
Process API, Local Models, restart, Pi-сессий.
