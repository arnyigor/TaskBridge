# План исправлений (аудит: отправка сообщений, очередь, локальные модели)

Порядок — по приоритету из аудита. Каждая правка закрывается и помечается ниже.

**Статус: все пункты выполнены (442/444 тестов pass, 0 fail, 2 skip). Полный прогон: `npm test`.**

После каждого пункта: `npm run check` (если есть) и релевантные тесты `node --test tests/<файл>`.

---

## 1. [x] [A1] server.mjs:845 — необъявленная переменная `q` (ReferenceError)
**Файл:** `src/server.mjs`, роут `GET /api/tasks/:id/runs`.
**Проблема:** `Number(q.get('limit'))` — переменная `q` не существует; любой запрос к `/api/tasks/:id/runs` падает с 500 (ReferenceError).
**Fix:** `Number(url.searchParams.get('limit')) || 50`.
**Тест:** `node --test tests/manager.test.mjs` (или smoke: GET /runs больше не 500).

## 2. [x] [M1/M2] local-models.mjs `#spawnRouter` — таймаут/ошибка spawn не убивает процесс
**Файл:** `src/local-models.mjs`.
**Проблема:** при таймауте `startTimeoutMs` роутер-процесс остаётся жить (`this.proc` занят, log-stream открыт, `state='STARTPING'`/`STARTING`); следующий `ensureRunning()` заспавнит второй процесс, первый утечёт. При `proc.on('error')` (ENOENT) `this.proc` также остаётся установленным.
**Fix:** при таймауте — kill дерева процесса + сброс `this.proc`/закрытие лога; при spawn-error — аналогично.
**Тест:** `node --test tests/local-models.test.mjs`.

## 3. [x] [A2] pi-rpc.mjs — дублирующиеся методы `setModel`/`setThinkingLevel`
**Файл:** `src/pi-rpc.mjs`.
**Проблема:** методы объявлены дважды; в классе побеждает последнее определение — фактические таймауты 30000/15000 мс вместо задуманных 60000/30000. Первый блок — мёртвый код.
**Fix:** оставить одну пару методов с таймаутами 60000 (`setModel`) и 30000 (`setThinkingLevel`).
**Тест:** `node --test tests/manager.test.mjs tests/model-catalog.test.mjs`.

## 4. [x] [A3] task-manager.mjs — неиспользуемая переменная `alreadyFinished`
**Файл:** `src/task-manager.mjs`, `#message()`.
**Проблема:** `alreadyFinished` вычисляется, но не используется; фактический guard уже реализован в `reservedElsewhere` (`task.status !== 'RUNNING'`).
**Fix:** удалить переменную; комментарий над ней оставить (он описывает актуальную семантику `reservedElsewhere`).
**Тест:** `node --test tests/queue-http.test.mjs tests/manager.test.mjs`.

## 5. [x] [M6] Router-mode + legacy-профили: конфликт конфигурации
**Файлы:** `src/server.mjs`, `config.json`.
**Проблема:** `/api/runtime/restart` и `/api/runtime/start` в router-mode оперируют legacy-профилями (`text`/`vision`), которые претендуют на тот же порт 8080 — рестарт legacy-профиля убьёт/займёт порт роутера.
**Fix:** заблокировать legacy runtime-эндпоинты при `manager.localModels.enabled` (возврат осмысленной ошибки NOT_CONFIGURED/BUSY); legacy-профили из `config.json` пользователя удалить (router-mode активен).
**Тест:** `node --test tests/manager.test.mjs tests/local-models.test.mjs`.

## 6. [x] [Q4] commandLedger — eviction без ограничения размера
**Файл:** `src/task-manager.mjs`, `#evictCommands()`.
**Проблема:** в памяти держатся все завершённые команды за 24 ч без верхней границы (TTL-фильтр работает только при `size >= 2`).
**Fix:** добавить max-size (например 1000 записей) с выбросом самых старых.
**Тест:** unit — вставить >max записей, убедиться в ограничении.

## 7. [x] [A4] pi-rpc.mjs — дублирование `env` в опциях spawn
**Файл:** `src/pi-rpc.mjs`.
**Проблема:** ключ `env` задан дважды в объекте опций spawn (основной + spread).
**Fix:** оставить одно объявление.

## 8. [x] [M3] RuntimeManager.getBusyStatus — семантика `every` vs `some`
**Файл:** `src/runtime-manager.mjs`.
**Проблема:** `busy: slots.every(is_processing)` — при `-np > 1` считается busy только когда заняты ВСЕ слоты, а `LocalModelService` использует `some`. Несогласованность.
**Fix:** привести к `some(...)` (согласовать с LocalModelService).

## 9. [x] [Q1] Окно гонки pump ↔ sendPendingNow (наблюдение)
**Файл:** `src/task-manager.mjs`.
**Проблема:** при `#pumpOnce` delegating-доставке `activeTaskId === null`, поэтому `sendPendingNow` другой сессии проходит проверку занятости машины.
**Fix (минимальный):** проверять также `this.pumping` в `sendPendingNow` / брать `#admit`-независимый флаг доставки.
**Тест:** `node --test tests/queue-http.test.mjs`.

## 10. [x] [M4] prevMetricSample — глобальное состояние между тестами (косметика)
**Файл:** `src/local-models.mjs`.
**Fix:** привязать сэмплы к инстансу `LocalModelService` вместо module-level Map.

## 11. [x] [R1] (найдено при верификации) Финализатор старого turn'а сбрасывал слот нового turn'а
**Файл:** `src/task-manager.mjs`, IIFE-финализатор `#message`.
**Проблема:** follow-up, принятый в момент финализации ответа (статус уже SUCCEEDED, слот ещё занят — окно между TASK_SUCCEEDED и `finally`), начинал новый turn, а финализатор старого turn'а в `finally` сбрасывал `activeTaskId` безусловно → очередь могла запустить другую сессию **параллельно работающей генерации** (нарушение capacity-1).
**Fix:** сброс слота только если `task._turn === turn` (та же защита, которую уже использует `#verifyAndFinalize`).
**Тест:** `tests/manager.test.mjs` — «a follow-up accepted while the turn is finalizing keeps the queue slot» (детерминированное воспроизведение через замедленный `writeArtifact`).

## Замечания верификации (без правок, осознанные trade-offs)

1. `dropPending` (SUCCEEDED-путь с workspace) публикует `QUEUE_DROPPED`, а не `TASK_SUCCEEDED` — ответ API несёт статус, клиенты на событиях полагаются на ответ/пул.
2. Узкое окно `cancel` между извлечением из очереди и `setStatus('PREPARING')` (микросекунды, через API; последующие `#executeInitial` уже защищены guard'ом).
3. `pendingFiles` — в памяти: рестарт теряет вложения у задач, ещё не начавших запуск (текст доставляется; `staged`-файлы сохраняются на диск).
4. `agent_start` в `#handlePiEvent` пишет RUNNING напрямую в store без события `STATUS` (UI видит через PI_EVENT).
5. Возможный тайминг-флак `queue-http` «delivery order» под высокой CPU-нагрузке (наблюдался 1 из 10 прогонов, не воспроизведён).

## Чеклист регрессии после каждого пункта

- `npm test` (полный прогон после всех правок; по пунктам — релевантные файлы).
- Smoke (если запущен живой сервер): `GET /api/tasks/<id>/runs` → 200; `POST /api/local/start` → state EXTERNAL/MANAGED_RUNNING.
