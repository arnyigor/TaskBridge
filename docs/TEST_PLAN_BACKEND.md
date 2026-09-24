# План тестирования бэкенда TaskBridge

Что проверяем: изменения бэкенда по [`TASKBRIDGE_BACKEND_PLAN.md`](TASKBRIDGE_BACKEND_PLAN.md) на ветке `claude/clever-lamport-hijxst` плюс регрессию всего, что работало до них. План рассчитан на основную машину (Windows, реальный Pi, при желании llama.cpp) и на Linux/macOS там, где поведение отличается.

Короткий пользовательский чек-лист — в [`TEST_PLAN.md`](../TEST_PLAN.md). Этот документ подробнее и включает его.

---

## 0. Что изменилось на ветке (что проверять в первую очередь)

| # | Изменение | Где | Автотест | Ручная проверка |
|---|---|---|---|---|
| C1 | `CONFLICT` / `UNKNOWN_AFTER_CRASH` → HTTP `409` (было `500`) | `src/server.mjs` | `tests/store-identity.test.mjs` | M4 |
| C2 | `USER_MESSAGE` несёт `commandId`/`clientId`, из очереди — `pendingId`; новое событие `PROMPT_QUEUED` | `src/task-manager.mjs` | `tests/queue-http.test.mjs`, `tests/store-identity.test.mjs` | M5, M6 |
| C3 | Баннер очереди в вебе убирает доставленное сообщение по `pendingId`, а не по тексту | `web/app.js` | — | M6 |
| C4 | `storeId` в `/api/info`; копия из бэкапа получает свой | `src/task-store.mjs` | `tests/store-identity.test.mjs` | M2, M3 |
| C5 | Версия Pi в `/api/info`, предупреждение `PI_VERSION_UNSUPPORTED` | `src/pi-version.mjs` | `tests/pi-version.test.mjs` | M1 |
| C6 | POSIX: Pi запускается лидером группы процессов, STOP убивает и его дочерние процессы | `src/pi-rpc.mjs` | `tests/pi-rpc-faults.test.mjs`, `tests/runtime-faults.test.mjs` | M7, M8 |
| C7 | Режимы отказа в fake-pi (`fault-*`) | `tests/fake-pi.mjs` | те же | — |
| C8 | Рекордер RPC-обмена с Pi | `scripts/pi-rpc-record.mjs` | — | раздел 3 |

**Риск C6 — главный.** Изменился способ запуска Pi на Linux/macOS. На Windows поведение не менялось (там `shell: true` и `taskkill /T`), но регрессию STOP на Windows всё равно нужно пройти (M7).

---

## 1. Подготовка

1. Node.js 22.13+ (`node --version`), Pi 0.85–0.87 (`pi --version`).
2. Сделать снимок рабочей базы перед любыми ручными тестами:
   ```powershell
   npm run backup
   ```
   Снимок попадает в `data\backups\taskbridge-<время>.db`.
3. Для ручных проверок через API удобнее выключить авторизацию (`server.auth.enabled: false` в `config.json`) на время тестов. Если она включена, запросы ниже нужно делать с cookie после pairing (или проверять те же вещи через веб-интерфейс).
4. Во всех командах ниже:
   ```powershell
   $base = 'http://127.0.0.1:8787'   # адрес с самого ПК; телефон — LAN-адрес из `taskbridge status`
   ```
5. Для сценариев с очередью нужен занятый режим модели. Самый простой способ — две сессии и долгий первый ход (см. M5).

---

## 2. Автоматические тесты

### 2.1 Полный прогон

```powershell
npm ci
npm run check      # синтаксис всех модулей + аудит секретов
npm test           # ~610 проверок, ~1 минута
```

**Ожидаемо:** `npm run check` — без ошибок, последняя строка `✔ no secret would leave this machine`.

`npm test` на Windows-машине разработчика — всё зелёное, кроме `skip` (живой Postgres и облачный DOM-тест).

**Известные падения в Linux-контейнере без Pi** (не связаны с веткой, есть и на `main`). Если они падают на Windows — это уже проблема, её нужно разбирать:

| Тест | Причина в контейнере |
|---|---|
| `machine() trusts only the last X-Forwarded-For entry…` (`access-machine`) | зависит от сетевых интерфейсов машины |
| `policy classifies destructive shell commands…` (`cloud-approvals`) | правила политики под Windows-пути |
| `setModel switches the session model…` (`manager`) | нужен настоящий `pi` в `PATH` (`spawn pi ENOENT`) |
| `with no roots configured, listing and resolving fail clearly` (`project-browser`) | зависит от домашнего каталога |
| `a request that never answers is aborted…`, `a request without a timeout…` (`transport-timeout`) | поведение event loop в этой версии Node |

**Нестабильные под нагрузкой (параллельный прогон):** `streaming stress: 3000 events…`. При падении перезапустить файл отдельно; если в одиночку тест зелёный — это не регрессия:

```powershell
node --test tests/cloud-stress.test.mjs
```

### 2.2 Тесты изменений этой ветки

```powershell
node --test tests/pi-version.test.mjs tests/store-identity.test.mjs tests/queue-http.test.mjs tests/pi-rpc-faults.test.mjs tests/runtime-faults.test.mjs
```

| Файл | Что доказывает |
|---|---|
| `pi-version.test.mjs` | разбор `pi --version` с префиксом и без; диапазон сравнивается как числа (`0.9.0` старше `0.85.0`); отсутствующий Pi — статус, а не исключение; результат кэшируется |
| `store-identity.test.mjs` | `storeId` стабилен между открытиями базы; у восстановленного бэкапа он другой; `/api/info` отдаёт `storeId` и `pi`; неподдерживаемая версия даёт предупреждение; повтор `commandId` с другим телом → `409 CONFLICT`; повтор с тем же телом не доходит до Pi второй раз; `USER_MESSAGE` несёт `commandId`/`clientId` |
| `queue-http.test.mjs` (новый тест в конце) | сообщение из очереди сохраняет `pendingId`/`commandId`/`clientId` от `PROMPT_QUEUED` до `USER_MESSAGE` |
| `pi-rpc-faults.test.mjs` | RPC-клиент: падение Pi посреди инструмента (код выхода и stderr), мусор и оборванный JSON (2 `protocol_error`, сессия живёт), кириллица, разрезанная посреди символа, Pi, игнорирующий `abort` (спасает `killTree`), дочерний процесс Pi умирает вместе с ним (не на Windows) |
| `runtime-faults.test.mjs` | те же отказы глазами клиента: `FAILED` + `PI_SESSION_FAILED` + хвост stderr, следующее сообщение поднимает сессию; `PI_PROTOCOL_ERROR` записан, ход завершён; STOP при глухом Pi даёт `CANCELLED` и убивает дочерний процесс |

**Контроль, что тесты ловят баг.** Проверка для C6: временно заменить в `src/pi-rpc.mjs` `detached: process.platform !== 'win32'` на `detached: false`. Тогда на Linux/macOS тесты `killing Pi also kills the processes it started` и `STOP ends a turn whose Pi ignores abort…` должны упасть с `child <pid> outlived …`. Вернуть обратно.

### 2.3 Повторяемость

Новые тесты не должны быть нестабильными. Прогнать 20 раз подряд:

```powershell
1..20 | % { node --test tests/runtime-faults.test.mjs tests/pi-rpc-faults.test.mjs 2>&1 | Select-String '^# fail' }
```

**Ожидаемо:** все 20 строк `# fail 0`.

После прогонов не должно остаться процессов fake-pi:

```powershell
Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'fake-pi|setInterval' } | select ProcessId, CommandLine
```
```bash
pgrep -af 'fake-pi|setInterval' || echo clean
```

### 2.4 Процессные проверки (не входят в `npm test`)

```powershell
npm run lan:acceptance   # убить турникет → агент жив, сессия цела, поток открывается
npm run smoke:pi -- "G:\path\to\project"   # реальный Pi: ожидание PI_RPC_OK: agent_settled received
```

---

## 3. Запись реальных RPC-транскриптов (B0)

Цель — получить настоящий обмен TaskBridge ↔ Pi для фикстур и узнать формат запросов расширений к UI. Без этого не закрываются B0 и часть B4.

### 3.1 Включение записи

1. Остановить TaskBridge: `taskbridge stop`.
2. В `config.json`:
   ```json
   "pi": { "command": "node G:/path/to/Taskbridge/scripts/pi-rpc-record.mjs", ... }
   ```
   На Linux/macOS — без `node`, путь к самому скрипту (он исполняемый):
   `"command": "/path/to/Taskbridge/scripts/pi-rpc-record.mjs"`.
   Если Pi вызывается не как `pi`, задать переменную `PI_REAL_COMMAND`.
3. Запустить TaskBridge: `start.cmd`.
4. Проверить: `Invoke-RestMethod "$base/api/info" | select -Expand pi` → `version` совпадает с `pi --version` (рекордер прозрачен).

Каждый процесс Pi пишет свой файл: `data\pi-rpc-records\<время>-<pid>.jsonl`. Строки — `{"t":секунды,"dir":"in|out|err|exit",...}`.

### 3.2 Сценарии — одна сессия на сценарий

Для каждого сценария создать **новую** сессию, чтобы получился отдельный файл. Имя сессии = код сценария.

| Код | Действие | Что должно попасть в запись |
|---|---|---|
| R1 | Scratch: «Ответь одним словом: привет» | `prompt` → `response` → `message_update`… → `message_end` → `agent_settled` |
| R2 | Проект: «Прочитай README.md и package.json, перечисли 3 зависимости» | несколько `tool_execution_start/end` |
| R3 | Проект: «Запусти `python -c "import time; time.sleep(120)"` и дождись» → через 10 с STOP | `clear_queue`, `abort` посреди инструмента, что Pi шлёт после |
| R4 | Выбрать провайдера с неверным ключом или остановленный llama.cpp → любой prompt | как выглядит ошибка модели |
| R5 | Включить `approvals.enabled` → «Удали файл tmp-test.txt» → разрешить; повторить → отклонить | текущий путь approvals (HTTP из расширения) |
| R6 | **Запрос расширения к UI**: вызвать расширение Pi, которое спрашивает пользователя (confirm/select/input) — например то, что вы используете в терминале | **главная цель**: кадры UI-запроса и как на них отвечать. Если TaskBridge не умеет ответить, записать, на чём ход застрял |
| R7 | Длинная сессия → COMPACT; затем сменить модель и thinking level | `compact`, `compaction_end`, `set_model`, `set_thinking_level` |
| R8 | Долгий ход → во время стриминга отправить сообщение (Enter) и ещё одно «Отправить сейчас» | `steer` / `follow_up`, прерывание |
| R9 | «Выведи содержимое большого файла целиком» (лог на несколько МБ) | длинный вывод инструмента |
| R10 | Сессия на кириллице: вопрос и ответ по-русски, с эмодзи | многобайтовые символы в реальном потоке |

### 3.3 После записи

1. Вернуть в `config.json` исходный `pi.command`, перезапустить TaskBridge.
2. **Просмотреть файлы перед отправкой:** в них промпты, пути к файлам, вывод инструментов и ответы модели. Вырезать лишнее или использовать для записи тестовый проект.
3. Сложить в архив `pi-rpc-records-<дата>.zip` и прислать. Из них будут сделаны `tests/fixtures/pi-rpc/`, `docs/pi-rpc-protocol.md` и воспроизведение в fake-pi.

---

## 4. Ручная приёмка изменений ветки

Для каждой проверки: шаги → ожидаемый результат. Отметка в отчёте: ✅ / ❌ (+ что увидели).

### M1. Версия Pi (C5)

1. `Invoke-RestMethod "$base/api/info" | select -Expand pi`
   → `version` = вывод `pi --version`, `supported = True`, `supportedRange = >=0.85.0 <0.88.0`, `error` пусто.
2. В `warnings` нет `PI_VERSION_UNSUPPORTED`: `(Invoke-RestMethod "$base/api/info").warnings`.
3. Неподдерживаемая версия. Остановить TaskBridge; в `config.json` поставить `"pi": { "command": "node G:/path/to/Taskbridge/tests/fake-pi.mjs", "env": { "FAKE_PI_VERSION": "0.99.0" } }`; запустить.
   → `pi.version = 0.99.0`, `supported = False`, в `warnings` есть `PI_VERSION_UNSUPPORTED` с понятным текстом; сервер работает.
4. Pi не найден: `"command": "pi-not-installed"`.
   → `version = null`, `error` объясняет причину, предупреждение есть, сервер стартовал.
5. Вернуть конфиг.

### M2. `storeId` стабилен (C4)

1. `$id1 = (Invoke-RestMethod "$base/api/info").storeId` — строка UUID.
2. `taskbridge stop`, `start.cmd`.
3. `(Invoke-RestMethod "$base/api/info").storeId` → равен `$id1`.

### M3. Бэкап получает свой `storeId` (C4)

> Меняет рабочую базу. Делать только после снимка из раздела 1.

1. `npm run backup` → путь к снимку `B`.
2. `taskbridge stop`. Переименовать `data\taskbridge.db` → `taskbridge.db.keep` (и `-wal`/`-shm`, если есть). Скопировать `B` в `data\taskbridge.db`. `start.cmd`.
3. `storeId` ≠ `$id1`. Список сессий — как на момент бэкапа.
4. `taskbridge stop`, вернуть `taskbridge.db.keep` на место, `start.cmd`, убедиться, что `storeId` снова `$id1` и все сессии на месте.

### M4. Повтор команды с другим телом → 409 (C1)

```powershell
$t = (Invoke-RestMethod "$base/api/tasks" -Method Post -ContentType 'application/json' -Body (@{projectId='__scratch__'; prompt='Ответь: ок'} | ConvertTo-Json)).id
# дождаться SUCCEEDED в UI, затем:
$body = @{text='второе'; commandId='manual-cmd-1'; clientId='tester'} | ConvertTo-Json
Invoke-RestMethod "$base/api/tasks/$t/message" -Method Post -ContentType 'application/json' -Body $body   # 200
Invoke-RestMethod "$base/api/tasks/$t/message" -Method Post -ContentType 'application/json' -Body $body   # 200, повтор
$bad = @{text='другое'; commandId='manual-cmd-1'; clientId='tester'} | ConvertTo-Json
try { Invoke-RestMethod "$base/api/tasks/$t/message" -Method Post -ContentType 'application/json' -Body $bad } catch { $_.Exception.Response.StatusCode.value__; $_.ErrorDetails.Message }
```
→ третий запрос: `409` и `"code":"CONFLICT"`; в чате сообщение «второе» **одно**; модель ответила один раз.

`projectId`: `__scratch__` — Scratch без проекта; для проекта — id из `GET /api/projects`.

### M5. Кто отправил и `PROMPT_QUEUED` (C2)

1. Сессия A: долгий ход (`python -c "import time; time.sleep(60)"`).
2. Пока A работает, в сессию B отправить через API:
   ```powershell
   Invoke-RestMethod "$base/api/tasks/$b/message" -Method Post -ContentType 'application/json' -Body (@{text='из очереди'; commandId='manual-q-1'; clientId='tester'} | ConvertTo-Json)
   ```
   → ответ со `status = QUEUED`, в `pendingPrompts[0]` есть `id`, `commandId = manual-q-1`, `clientId = tester`.
3. `Invoke-RestMethod "$base/api/tasks/$b/events?limit=0" | ? type -eq 'PROMPT_QUEUED' | select -Expand data`
   → `pendingId` = `pendingPrompts[0].id`, `commandId`, `clientId`.
4. Дождаться конца A. Сообщение уходит само.
   `... | ? type -eq 'USER_MESSAGE' | select -Last 1 -Expand data` → `text = из очереди`, тот же `pendingId`, `commandId = manual-q-1`, `clientId = tester`.

### M6. Веб-баннер очереди с одинаковыми сообщениями (C3)

1. Как в M5, занять модель сессией A.
2. В сессии B в вебе поставить в очередь **два одинаковых** сообщения «повтор» (Enter дважды) и третье «другое».
3. Над полем ввода — 3 записи.
4. После конца A записи исчезают **по одной**, по мере доставки, в порядке отправки. Ни в какой момент не пропадают две сразу, в конце очередь пуста, в чате три сообщения по порядку.
5. Повторить с «Убрать» на втором «повтор» до доставки: остаются первый «повтор» и «другое».

### M7. STOP убивает дочерние процессы (C6)

**Windows (регрессия):**
1. Проект → «Запусти `python -c "import time; time.sleep(600)"` и жди завершения».
2. Убедиться, что процесс есть: `Get-Process python`.
3. STOP. → Сессия `CANCELLED` за несколько секунд; `Get-Process python` не показывает этот процесс; `Get-CimInstance Win32_Process | ? CommandLine -match 'mode rpc'` — Pi этой сессии нет (если сессия закрывается) или он жив, но без детей.

**Linux/macOS (новое поведение):**
1. То же с `sleep 600`.
2. `pgrep -af 'sleep 600'` — есть.
3. STOP → `pgrep -af 'sleep 600'` пусто. **До исправления здесь процесс оставался.**

### M8. Остановка TaskBridge во время хода (C6)

Pi теперь в своей группе процессов и не получает Ctrl+C из терминала напрямую — его останавливает сам TaskBridge.

1. Запустить сервер в терминале (`npm run start:monolith` или `taskbridge start`), начать долгий ход с `sleep 600`.
2. Ctrl+C в терминале сервера (или `taskbridge stop`).
3. В течение ~5 секунд: `pgrep -af 'mode rpc'` и `pgrep -af 'sleep 600'` → пусто.
4. На Windows — `taskbridge stop` в обоих режимах (LAN и `--monolith`): `Get-CimInstance Win32_Process | ? CommandLine -match 'mode rpc'` → пусто, дочерний процесс хода тоже исчез. На Windows нет SIGTERM, поэтому остановка убивает всё дерево (`taskkill /T /F`) без мягкого завершения; до исправления в режиме `--monolith` занятый Pi и его дети переживали сервер (найдено на прогоне b821a52).

**Известное ограничение (не баг ветки):** при аварийном убийстве сервера (`kill -9`, «Снять задачу») Pi и его дети переживают сервер. Это пункт B1 (PID в SQLite и зачистка сирот при старте). Зафиксировать, что осталось, в отчёте для сравнения после B1.

### M9. Pi упал посреди хода

1. Долгий ход с инструментом (как в M7).
2. Убить **процесс Pi** этой сессии (не сервер): Windows — `Stop-Process -Id <pid>` (pid из `Get-CimInstance Win32_Process | ? CommandLine -match 'mode rpc'`), Linux — `kill -9 <pid>`.
3. → Сессия `FAILED`, `errorCode = PI_SESSION_FAILED`, текст с кодом выхода; в событиях есть `PI_STDERR` (если Pi успел что-то написать); статус не висит в `RUNNING`.
4. Отправить «продолжай» → Pi поднимается с тем же файлом сессии, модель видит прошлую историю (спросить «что я просил выше?»).

---

## 5. Регрессия веб-интерфейса и API

Проходится на телефоне (LAN) и на ПК. Базовые пункты — из [`TEST_PLAN.md`](../TEST_PLAN.md).

| # | Сценарий | Ожидаемо |
|---|---|---|
| W1 | Scratch: «Создай hello.txt со строкой TASKBRIDGE_OK, прочитай и сообщи» | живой стриминг, карточки инструментов, `SUCCEEDED` |
| W2 | STOP на долгой команде | `CANCELLED`, агент остановлен |
| W3 | Follow-up во время работы (Enter) | уходит через steer, отвечает в том же ходе |
| W4 | «Отправить сейчас» (Ctrl+Enter) во время работы | текущий ход прерван, сообщение выполнено следующим |
| W5 | Очередь при занятой модели: 3 сообщения, «Отправить сейчас» для ждущей сессии, «Убрать» | объяснение «Сейчас нельзя…», сообщения не теряются, «Убрать» удаляет ровно одно |
| W6 | Вложение с телефона (фото) + текст | файл виден в чате, агент его читает |
| W7 | Править / ветвить / удалить ход / перегенерировать | история на экране = история после обновления страницы |
| W8 | COMPACT на длинной сессии | статистика до/после |
| W9 | Смена модели и thinking level в живой сессии | `MODEL_SWITCH`, следующий ответ другой моделью |
| W10 | Импорт Pi-сессии (clone) | история видна, исходный JSONL не изменён (сравнить размер/время) |
| W11 | Длинная сессия: «Показать более раннюю историю» | подгрузка страницами, без дублей |
| W12 | Обрыв Wi-Fi на телефоне на 30 с во время хода, возврат | лента догоняет без пропусков и дублей |
| W13 | Перезапуск турникета (`npm run lan:acceptance` или вручную) во время хода | ход продолжается, телефон переподключается |
| W14 | Перезапуск сервера (`taskbridge stop` / `start`) во время хода | сессия `FAILED_RECOVERY` (пока так, до B6), новое сообщение продолжает её |
| W15 | Две вкладки/устройства на одной сессии | обе видят одно и то же; сообщение из одной появляется в другой |
| W16 | Approvals (`approvals.enabled`): разрешить / отклонить с телефона | ход продолжается / инструмент заблокирован |
| W17 | Worktree-проект: изменить файл → diff → apply | основной checkout меняется только после apply |

---

## 6. Chaos-набор (перед релизом)

| # | Действие | Ожидаемо сейчас | Цель после B1/B6 |
|---|---|---|---|
| X1 | Убить Pi посреди инструмента (M9) | `FAILED` + `PI_SESSION_FAILED`, продолжение работает | `RESTORABLE` |
| X2 | Убить сервер (`kill -9` / «Снять задачу») посреди хода | после старта — `FAILED_RECOVERY`; Pi и дети **остаются** (записать) | `RESTORABLE`, сирот нет |
| X3 | Обрыв SSE (закрыть вкладку/сеть) посреди хода, вернуться | история без дыр и дублей | то же |
| X4 | Один `commandId` дважды одновременно (два `Invoke-RestMethod` в `Start-Job`) | одно сообщение в чате, второй запрос — повтор или «в процессе» | то же |
| X5 | Три клиента: одновременно prompt, STOP и ответ на approval | детерминированный итог, без зависших статусов | тест B4 |
| X6 | Выключить llama.cpp посреди хода | понятная ошибка движка, сессия не висит | то же |
| X7 | Восстановить базу из бэкапа при открытом телефоне | `storeId` изменился (M3); веб — перезагрузить страницу | KMP сбрасывает кэш сам |

---

## 7. Soak (ночной прогон)

1. Автоматический:
   ```powershell
   $env:TASKBRIDGE_STRESS_SECONDS = 1800; npm run stress
   ```
2. Реальный: вечером поставить 3–5 задач в очередь на локальной модели (длинные, с инструментами), оставить на ночь.
3. Утром проверить:
   - нет сессий, висящих в `RUNNING`/`CANCELLING` без активности;
   - процессы: ровно столько `pi --mode rpc`, сколько живых сессий; нет осиротевших `python`/`node`/`gradle` от агента;
   - `data\taskbridge.db` вырос в разумных пределах (записать размер вечером и утром);
   - в `data\tasks\<id>\artifacts\pi.stderr.log` нет неожиданных ошибок протокола.

---

## 8. Отчёт

Скопировать и заполнить:

```text
Коммит:            (git log --oneline -1)
ОС / Node / Pi:    Windows 11 / 22.x / 0.87.x
Модель:            ...
Дата:

2.1 npm run check:   ✅/❌
2.1 npm test:        pass N / fail N (перечислить падения)
2.2 тесты ветки:     ✅/❌
2.3 20 прогонов:     fail 0 во всех? остались процессы?
2.4 lan:acceptance / smoke:pi:  ✅/❌

M1 … M9:    ✅/❌ + что увидели
W1 … W17:   ✅/❌
X1 … X7:    ✅/❌ + что осталось из процессов
Soak:       ✅/❌ + размеры БД, зависшие сессии, сироты

Транскрипты R1–R10: записаны / какие нет и почему
```

Для каждого ❌ приложить:
- id сессии и время;
- `Invoke-RestMethod "$base/api/tasks/<id>/events?limit=0" | ConvertTo-Json -Depth 20 > events.json`;
- `data\tasks\<id>\artifacts\pi.stderr.log` и `pi-events.jsonl`;
- вывод консоли сервера (или `data\*.log`, если сервер запущен через `start.cmd`);
- скриншот телефона, если проблема видна в интерфейсе.

## 9. Критерии прохождения

Ветку можно вливать, если:
- `npm run check` чистый, `npm test` без падений на Windows (кроме `skip`);
- новые тесты (2.2) проходят 20 раз подряд без сирот;
- M1–M9 все ✅ (M8 обязателен на той ОС, где реально работает сервер);
- W1–W17 без регрессий относительно `main`;
- X1, X3, X4 ✅; X2 — поведение совпадает с описанным «сейчас» (сироты фиксируются, но не блокируют: это B1).
