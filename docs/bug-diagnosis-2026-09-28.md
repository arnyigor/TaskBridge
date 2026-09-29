# Диагноз трёх багов и план правок (2026-09-28)

Все выводы ниже — из работающего сервера, его логов и журнала событий задач, а не из чтения кода.
Рабочее дерево изменено (`git status`: 12 файлов), но **запущенный сервер старше дерева** — см. п. 0.

## 0. Состояние стенда на момент разбора

| Что | Факт | Как проверено |
| --- | --- | --- |
| app-сервер | PID 1368, `127.0.0.1:49762`, жив | `Get-NetTCPConnection`; `data/lan.json` |
| LAN-прокси | PID 30968, `0.0.0.0:8787` + `8443` | `Get-NetTCPConnection` |
| API | `GET /api/info` → 200, `GET /api/tasks` → 200 | curl |
| Сборка сервера | `0.11.0`, commit `921fc46` | `/api/info` |
| Новый маршрут @-ссылок | `GET /api/tasks/:id/workspace-files` → **404** | curl |
| Перезапуски app | 33 строки `listening` в `data/lan-app.log`, каждый раз **новый порт** (…49831, 49829, 49762) | grep лога |

Вывод: @-features из дерева (`workspace-files`, `Composer.kt`) в запущенном сервере нет.

## 1. «Постоянно показывается, что нет связи с компьютером»

**Механизм (подтверждён логами):** внутренний порт app выбирается случайным при каждом старте.

* `scripts/start-lan.mjs`: `const internalPort = await freePort()` — случайный свободный порт на каждый запуск.
* `src/proxy.mjs`: `createReverseProxy({ upstreamPort })` — порт берётся из env `LAN_INTERNAL_PORT` **один раз при старте прокси** и больше не перечитывается, `data/lan.json` прокси не знает.
* Следствие: app перезапустился → прокси остался на старом порту → каждый запрос телефона оканчивается `BAD_GATEWAY`.

**Доказательства:**
* `data/lan-restart-proxy.log`: **171** строк `[proxy] upstream 127.0.0.1:<port> unreachable: socket hang up`; в начале лога `-> 127.0.0.1:49757`, в конце `-> 49762` — порт менялся.
* `data/lan-app.log` (33 старта) — порты 49831 → 49829 → 49762 подряд.

**Не подтверждено:** точное совпадение по времени с тем, что видел оператор (в логе прокси строки без таймстемпов).

**План правок (минимальный):**
1. `src/proxy.mjs`: при ошибке upstream перечитывать `data/lan.json` и переключать `upstreamPort` (self-heal), вместо вечной привязки к порту старта. Тогда перезапуск app не требует перезапуска прокси.
2. `scripts/start-lan.mjs`: если публичный порт занят живым прокси, а его app мёртв — убивать/перезапускать пару, а не поднимать новый app на новом порту (сейчас возможен «осиротевший» прокси).
3. Проверка: `node --test tests/lan*.test.mjs` + `scripts/lan-acceptance.mjs`; руками — убить app, дождаться автостарта и убедиться, что `curl 8787/api/info` → 200 без перезапуска прокси.

## 2. «Невозможно с телефона добавить картинку в чат»

**Серверная часть работает — проверено по факту, а не по коду:**

* Файл реально лёг на диск: `.taskbridge-input/f7fd6aef2797/67d0e2c2-ff96-4f54-8b36-c5fb57f7b84c/Screenshot_20260928-200642.jpg`.
* В карточке задачи: `attachments: [{name: Screenshot_20260928-200642.jpg, size: 408708, mimeType: image/jpeg, direction: input, path: .taskbridge-input/...}]`.
* Событие `USER_MESSAGE` (seq 5906, 15:07:55Z) несёт `data.files: [{...mimeType: image/jpeg...}]` — то есть клиент получает метаданные и может нарисовать чип.
* Текст сообщения в событии — **без** служебной строки; маркер `Additional files from the phone are in .taskbridge-input/` добавляется только в промпт для Pi (`#deliverMessage`: `message = userText + note`, в событие уходит `userText`).

**Что реально может выглядеть как «картинка не добавилась» (не проверено мной):**
* агент её «не видит»: в `data/lan-restart-app.log` есть `Модель qwen-27b-q3-vision не загрузилась (код 99)` — при не-визуальной/незагрузившейся модели картинка приходит, но ответ звучит как «изображения нет»;
* в старом билде, который сейчас запущен, служебная строка-маркер показывалась как текст сообщения (в дереве уже есть тест `phoneAttachmentMarkerIsNotShownAsMessageText`, но в запущенное приложение он не попал).

**Нужно уточнение перед правками:** что именно видит оператор — нет чипа в сообщении, нет превью, или агент отвечает, что картинки нет. Это разные правки (UI чипа / превью / подбор визуальной модели).

## 3. «Сессия не может прерваться, зависла и глючит»

**STOP на сервере работает** — журнал сессии `f7fd6aef2797`:

```
15:09:37.902 STATUS CANCELLING "Stopping Pi"
15:09:38.054 RUNTIME_STATE ABORTING → IDLE
15:09:38.056 TASK_CANCELLED
...
15:17:44.989 STATUS CANCELLING "Stopping Pi"
15:17:46.674 TASK_CANCELLED
15:17:47.566 MODEL_SWITCH deepseek/deepseek-flash
15:17:50.581 STATUS RUNNING "Follow-up sent to Pi"      <-- без USER_MESSAGE
15:17:50.582 RUNTIME_STATE IDLE → WORKING
15:17:50.586 pi: agent_start / turn_start
```

То есть: отмена проходит за ~1.5 с, но через 4 с сессия **сама** уходит в RUNNING без нового сообщения оператора.

**Откуда взялось это «само» (сужено по коду, но не доказано однозначно):**
* В событии нет `USER_MESSAGE`, значит доставка шла с `announce:false`. Этот флаг ставят только: `#continueTurn` (POST `/continue`, строка 2423), `#regenerateLastTurn` (2362), `edit` (2331) и восстановление после перезапуска сервера (364–372), которое кладёт в очередь `resume-{...}` с `CONTINUE_PROMPT`.
* Перезапуска сервера в этот момент не было: `data/lan.json` → `startedAt 11:48:49Z`, app PID 1368 стартовал 16:48:31 локально (=11:48:31Z), последняя строка `listening` в `lan-app.log` — 49762, тот же процесс. Значит **boot-recovery не при чём**.
* Остаются клиентские пути: кнопка «Продолжить ответ»/«Ответить заново» либо повтор команды из outbox. Косвенно: в `lan-app.log` последняя строка — `Дождитесь завершения ответа перед сменой модели.`, т.е. оператор в те же секунды несколько раз жал смену модели.
* Симптом «глючит» подтверждается логами: многократно `Pi RPC timeout for get_state: no output from the Pi process for 15s — it looks hung.` и `Другой запрос этой сессии ещё отправляется. Повторите позже.` (CommandInFlight, у клиента до 30 повторов → статус Unknown).

**План правок:**
1. **Диагностика (дешёвая, обязательна перед фиксом):** логировать причину каждой `announce:false` доставки (`continue`/`regenerate`/`edit`/`resume`) в событие, например `DELIVERY` с полем `reason`. Сейчас по журналу отличить их невозможно — именно поэтому причина не установлена.
2. После этого — правка по факту:
   * если виноват `#continueTurn` из UI: не давать «Продолжить ответ» у ответа, который оператор только что отменил (STOP), либо требовать явного подтверждения;
   * если виноват outbox-ретрай клиента: не повторять команду после `TASK_CANCELLED` (в KMP `ChatSession` — не возобновлять отменённую доставку);
   * если виновата очередь `resume-` — не доставлять её, если после `inFlightPrompt` записан `TASK_CANCELLED` от оператора.
3. Сопутствующее (подтверждено логом): разобраться с `Pi RPC timeout for get_state` — таймаут 15 с на живой, но занятой Pi; при длинных ответах это и даёт «зависла».

## Что уже сделано в этом сеансе (не связано с 1–3)

* Список сессий: блок «Активные сессии» над папками (`SessionsScreen.kt`) — все `DisplayState.active` (WORKING/WAITING_USER/QUEUED), клик открывает чат, выбранная подсвечивается.
* Чат: уведомление `MCP: servers connected…` больше не попадает в ленту сообщений, а хранится в `ChatSnapshot.mcpNotice` и показывается в настройках сессии (`ModelSheet`, секция «MCP»).

## 4. Параллельная работа в одном рабочем дереве (важно для 1–3)

В репозитории одновременно работает **другая сессия агента** (в списке задач висят RUNNING `cb0a65239b6d` — `bash: node --test tests/queue-http.test.`, `104d23c1a21f` — `bash: sleep 720`).

| Файл | mtime (локально) |
| --- | --- |
| `src/task-manager.mjs` | **20:17** (= 15:17Z, ровно момент инцидента со STOP) |
| `tests/manager.test.mjs` | 20:16 |
| `src/session-history.mjs` | 20:14 |
| `src/server.mjs` | 17:25 |

Следствия, которые надо учитывать при разборе и фиксах:
* правки `src/*.mjs` не подхватываются живым процессом без перезапуска, поэтому поведение в 15:09–15:17Z шло ещё со старого кода — но любая проверка тестов/«restart-and-verify» у соседней сессии перезапускает сервер под работающими сессиями и даёт обрывы связи/`get_state` таймауты;
* `git status` содержит изменения, которых я не делал (`src/task-manager.mjs`, `src/session-history.mjs`, `tests/manager.test.mjs`) — их не трогать и не откатывать.

## 5. «При добавлении файла в чате на телефоне выходил из чата» — найден краш (logcat устройства)

Устройство подключено по adb (`versionName=1.1.5`, обновлено 2026-09-28 19:13). В `logcat` — **два фатальных краша приложения**, и оба кончаются `Force finishing activity ru.arny.taskbridge/.MainActivity` → оператора выбрасывает из чата.

### 5.1 OOM при чтении ответа сервера (это и есть «вылетел при добавлении файла»)

```
09-28 20:12:40.738 E AndroidRuntime: FATAL EXCEPTION: DefaultDispatcher-worker-15
java.lang.OutOfMemoryError: Failed to allocate a 6557984 byte allocation
    with 2335776 free bytes and 2281KB until OOM, target footprint 268435456
  at kotlinx.io.Utf8Kt...readString
  at io.ktor.client.statement.HttpResponseKt.bodyAsText(HttpResponse.kt:127)
  at TaskBridgeApi.decode(TaskBridgeApi.kt:448)
  at TaskBridgeApi.call(TaskBridgeApi.kt:431)
09-28 20:12:40.966 W ActivityTaskManager: Force finishing activity ru.arny.taskbridge/.MainActivity
09-28 20:12:40.958 I ActivityManager: Process ru.arny.taskbridge (pid 5938) has died
```

Что установлено по коду и данным:
* `TaskBridgeApi.decode()` (строка 448) для **любого** JSON-ответа делает `response.bodyAsText()` — весь ответ материализуется в одну `String`; лимита нет.
* `upload()` (строка 306) — **multipart**, `submitFormWithBinaryData`, base64 нет: сама отправка картинки память не раздувает (мой первый curl бил в `/api/upload` вместо `/api/uploads` и получил «Требуется JSON-запрос» — это была моя ошибка, не баг сервера).
* Память добивают **события чата с картинкой**: в журнале сессии `f7fd6aef2797` вхождения `Screenshot` — 142 в PI_EVENT-фреймах (результаты инструментов содержат данные изображения), и клиент держит до 500 таких событий в `ChatSession.cachedEvents`, плюс `decode` тянет окно целиком в строку, плюс `saveChat` сериализует всё окно в JSON-строку. Heap на телефоне 256 МБ, в момент падения было занято 253 МБ.

### 5.2 `NoSuchFileException` в записи кэша чата — **исправлено**

```
09-28 14:14:09.422 E AndroidRuntime: FATAL EXCEPTION: DefaultDispatcher-worker-8
java.nio.file.NoSuchFileException: /data/user/0/ru.arny.taskbridge/files/chat-cache/6eae0fb3/e986173276e4.chat.json.tmp
  at sun.nio.fs.UnixCopyFile.move
  at ru.arny.taskbridge.platform.AndroidChatPersistence$write$2(Platform.android.kt:127)
```

Причина: все записи одного файла использовали **один и тот же** `.tmp`; кэш чата пишется из нескольких корутин, первый писатель уносил временный файл, у второго падал `ATOMIC_MOVE`, а запасной `Files.move` был **вне** `runCatching` → непойманное исключение в корутине под `SupervisorJob` → смерть процесса.

Правка (сделана): `Platform.android.kt::write` — уникальное имя временного файла на каждую запись (`UUID`), запасной `move` обёрнут в `runCatching`, временный файл удаляется при неудаче. Семантика (ошибка записи видна вызывающему) сохранена.

### 5.3 Что сделано по OOM (5.1) и что проверено

Сделано (KMP, клиент; сервер не трогал):

1. **Не держать неиспользуемые тяжёлые данные фреймов** — `lightenEvent` в [ChatSession.kt](../clients/kmp/core/client/src/commonMain/kotlin/ru/arny/taskbridge/core/client/session/ChatSession.kt): из событий, которые клиент оставляет в памяти и пишет в кэш, убираются только те поля, которые reducer не читает (`agent_end.messages`, `turn_end.message`, `message_*.message` для роли `toolResult`, `tool_execution_end.result` / `tool_execution_update.partialResult` кроме `subagent`, `args.content` у `tool_execution_start`). Транскрипт от этого не меняется — закреплено тестом.
2. **Ограничение чтения тела ответа** — `readTextBody` в [TaskBridgeApi.kt](../clients/kmp/core/api/src/commonMain/kotlin/ru/arny/taskbridge/core/api/TaskBridgeApi.kt): было `bodyAsText()` без лимита, теперь чтение с потолком 16 МБ и понятной ошибкой `RESPONSE_TOO_LARGE` вместо OOM (сервер сам капает tool output на 4 МБ, так что потолок недостижим на нормальных ответах).
3. Ранее в этом же разборе: гонка временного файла в записи кэша (`Platform.android.kt`).

Измерения и проверки:
* на реальном окне событий упавшей сессии (`tail=400`, 1.42 МБ) отбрасываемые поля — **0.98 МБ из 1.42 МБ (69%)**; выигрыш в памяти больше, чем в байтах JSON (дерево `JsonObject` весит на порядок больше текста);
* новый тест [ChatEventLighteningTest.kt](../clients/kmp/shared/src/jvmTest/kotlin/ru/arny/taskbridge/core/client/session/ChatEventLighteningTest.kt): поля реально исчезают, нужные остаются, транскрипт из облегчённых событий **идентичен** исходному;
* `./gradlew :shared:jvmTest` — BUILD SUCCESSFUL; `:androidApp:assembleDebug` — BUILD SUCCESSFUL; установлено на телефон (versionCode 7, lastUpdateTime 2026-09-28 20:36:14), процесс поднимается без крашей; в dex проверено наличие `Активные сессии`, `RESPONSE_TOO_LARGE`, `lightenEvent`, `mcpNotice`.

**Не проверено:** что OOM больше не повторяется на устройстве (экран телефона был выключен, воспроизведение не гонял по просьбе оператора); остаются известные риски: `download()` читает картинку целиком в `ByteArray` без лимита, и битмап большого фото в предпросмотре может съесть память сам по себе.

## Проверки, выполненные в этом сеансе

| Проверка | Результат |
| --- | --- |
| `./gradlew :shared:jvmTest` | BUILD SUCCESSFUL |
| `./gradlew :shared:jvmTest --tests …ChatReducerNoticeAndAttachmentTest` | BUILD SUCCESSFUL (новый тест) |
| `./gradlew :shared:compileAndroidMain` | BUILD SUCCESSFUL |
| `node --test tests/project-browser.test.mjs` | 10/10 pass |
| `node --test tests/*.test.mjs` | прерван (долгий набор); успевшие тесты pass, включая контрактный «every published route is really served» |
| `curl /api/info`, `/api/tasks`, `/api/tasks/:id/events` | 200, данные реальные |

## Риски

* Правки из дерева **не в запущенном приложении** — эффект увидит только после сборки/установки portable-версии.
* Фиксы по п. 1 и 3 затрагивают сетевой путь телефона и жизненный цикл Pi; применять по одному, с проверкой `lan-acceptance.mjs`.
