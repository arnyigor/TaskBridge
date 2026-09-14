# TaskBridge HTTP API — контракт

Машиночитаемый список маршрутов — [`src/api-contract.mjs`](../src/api-contract.mjs).
Он не «документация рядом с кодом»: тест `tests/api-contract.test.mjs` поднимает
живой сервер и падает, если хоть один маршрут из списка перестал отвечать. Эта
страница — то, что нужно знать, чтобы написать клиент (веб уже написан; следующим
будет Android/KMP).

Текущая версия: **`apiVersion = 1`**, её отдаёт `GET /api/info` → `apiVersion`.

## Правило версий

- добавили маршрут — дописали сюда и в `src/api-contract.mjs`, версия не меняется;
- меняется форма или смысл существующего — поднимаем `API_VERSION` и пишем здесь, что изменилось;
- клиент обязан прочитать `apiVersion` и отказаться работать с незнакомой версией, а не угадывать.

## Адрес и авторизация

Базовый адрес — откуда загружен сервер (`http://<host>:8787`). Все ответы — JSON,
кроме помеченных как бинарные.

Авторизация выключена, пока `server.auth.enabled = false` (по умолчанию). Когда
включена:

- `GET /api/auth/pairing` отдаёт текущий код **только на самом компьютере**
  (проверяются и адрес клиента, и заголовок `Host` — поэтому обратный прокси
  обязан сохранять `Host` неизменным);
- `POST /api/auth/pair` с кодом выдаёт cookie `taskbridge_session=<expires>.<nonce>.<sig>`
  (HMAC-подпись, срок до 31 суток);
- без cookie закрытые маршруты отвечают `401/403` с `code: "AUTH_REQUIRED"`.

> Для нативного клиента cookie неудобна. Планируемая замена — `Authorization: Bearer …`;
> это изменение контракта, а не «деталь реализации» (см. «Чего пока нет»).

## Ошибка

Любой неуспех — один и тот же конверт:

```json
{ "error": "Сессия не найдена.", "code": "NOT_FOUND" }
```

Важно различать два `404`: несуществующий **маршрут** отвечает
`{ "error": "Not found" }`, а несуществующая **сессия** — другим текстом. Клиент
не должен считать «Not found» обычной ошибкой ресурса: это признак расхождения
версий.

## Поток работы (модель для клиента)

1. `POST /api/tasks` — создать задачу в проекте. Ответ содержит `id`.
2. `GET /api/tasks/:id/stream` (SSE) — живая лента. При обрыве клиент
   переподключается и передаёт `Last-Event-ID: <последний seq>`.
3. `GET /api/tasks/:id/events?after=<seq>` — то же самое, но «пачкой»: этим
   закрывается разрыв, если лента не поднялась (фон, Doze, потеря Wi-Fi).
4. `POST /api/tasks/:id/message` — follow-up/steering. `{ "now": true }` прерывает
   текущую генерацию, обычный вызов встаёт в очередь.
5. `POST /api/tasks/:id/cancel` — STOP.

**Ключевое свойство для мобильного:** задача живёт часами и **не держит HTTP**.
Клиент может уйти в фон и вернуться — он догоняет историю по `seq`.

## Ресурсы

### `Task`

`id`, `title`, `prompt`, `projectId`, `status`, `createdAt`, `updatedAt`,
`model: { provider, id }`, `requestedModel`, `thinkingLevel`, `workspacePath`,
`queueReason`, `current`, `errorCode`, `error`, `files[]`, `compaction`, `lastUsage`,
`metrics`, `outputFiles[]`, `nativeSource`, `applied`, `worktree`.

Полный набор полей — в ответе `GET /api/tasks/:id`; сервер вправе добавлять поля,
поэтому клиент должен игнорировать незнакомые, а не падать.

### Статусы

`QUEUED` · `PREPARING` · `PREFLIGHT` · `RUNNING` · `WAITING_USER` · `VERIFYING` ·
`CANCELLING` · `SUCCEEDED` · `FAILED` · `CANCELLED`

Активные: всё до `CANCELLING` включительно. Терминальные: `SUCCEEDED`, `FAILED`,
`CANCELLED`. Показывать пользователю нужно подписи, а не коды (в вебе это
`TASK_STATUS_LABELS`).

### `TaskEvent`

```json
{ "taskId": "…", "seq": 412, "type": "TASK_SUCCEEDED", "message": "Done", "data": {} }
```

Типы, которые клиенту нужно понимать:

- поток: `USER_MESSAGE`, `PI_EVENT` (в `data.pi` — сырой кадр Pi), `STATUS`;
- итог: `TASK_SUCCEEDED`, `TASK_FAILED`, `TASK_CANCELLED`, `VERIFICATION`, `VERIFICATION_ERROR`;
- правка истории: `TURN_EDITED` (текст сообщения перезаписан, `seq` тот же),
  `TURN_TRUNCATED` (ходы после `fromSeq` убраны — в том числе в живом чате);
- прочее: `MODEL_SWITCH`, `THINKING_LEVEL`, `COMPACT_REQUESTED`, `QUEUE_*`,
  `APPROVAL_REQUIRED`, `APPROVAL_RESOLVED`, `LOCAL_MODEL_PROGRESS`, `RUNTIME_*`,
  `WORKSPACE_READY`, `OUTPUT_FILES`, `TOOL_OUTPUT`, `CHANGES_APPLIED`, `WORKTREE_REMOVED`,
  `TASK_FORKED`, `SESSION_RESTORED`, `ENGINE_SWITCH`, `PI_STDERR`, `PI_PROTOCOL_ERROR`,
  `ABORT_TIMEOUT`, `QUEUE_DROPPED`.

Список открытый: **неизвестный тип клиент обязан игнорировать**, а не падать.

## Гарантии

- **`seq` строго монотонен** в пределах задачи и сохраняется между перезапусками.
  Курсоры `after` и `Last-Event-ID` поэтому не ломаются.
- **Идемпотентность.** `POST /api/tasks`, `/message`, `/cancel`, `/apply` принимают
  `commandId` (+ `clientId` устройства). Повтор с тем же `commandId` не создаёт
  вторую задачу — критично для мобильной сети. Итог команды доступен через
  `GET /api/commands/:commandId`.
- **Курсоры истории.** `after` — «дай после seq», `tail` (+`before`) — постраничная
  выдача, выровненная по ходам, для длинных сессий.
- **Ограничение размера.** Один запрос отдаёт не больше `maxEventsPerRequest`
  событий (по умолчанию 20000); глубже — через `tail`/`before`.
- **Вложения.** `POST /api/uploads` (multipart, потоково) возвращает `token` и
  `files[].id`; в задачу/сообщение передаётся `uploadToken` и `ids`. Клиентские
  имя/размер не принимаются на веру.
- **Долгие задачи не держат соединение.** Ни один HTTP-запрос не остаётся открытым
  на время работы агента.

## Маршруты

Полный список с методами и назначением — в `src/api-contract.mjs` (и в
[README](../README.md#http-api) в человекочитаемом виде). Группы: статус и метрики,
авторизация, проекты и файлы, сессии/модели, задачи (создание, управление,
переписывание истории, approvals, артефакты), локальный runtime, MCP, push, облако.

Потоковые (`SSE`) маршруты — только два: `GET /api/tasks/:id/stream` и
`GET /api/local/events`.

## Чего пока нет

- **OpenAPI/Swagger-схемы.** Пока контракт — это список маршрутов + эта страница +
  проверяющий тест. Схему (и генерацию Kotlin-клиента) можно добавить поверх
  `src/api-contract.mjs`, когда появится второй клиент.
- **Bearer-токена.** Только cookie. Для Android/KMP нужно добавить — это изменение
  контракта (поднять `API_VERSION`).
- **Push для нативного клиента.** Есть web-push (VAPID) — он работает только в
  браузере; приложению нужен FCM или foreground-сервис.
- **Версионирования ответов.** `apiVersion` описывает весь API целиком; частичных
  версий по маршрутам нет.
