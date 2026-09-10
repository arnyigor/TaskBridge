# TaskBridge Cloud MVP

Облачный слой не запускает Pi и не хранит локальную рабочую копию. Он служит
Internet bridge между браузером и TaskBridge на ПК:

```text
browser → Vercel Functions → Vercel Queues → TaskBridge PC → Pi
browser ← Vercel Functions ← Vercel Queues ← durable local outbox
```

Локальный `data/taskbridge.db` остаётся source of truth. В облаке отдельной
PostgreSQL/Redis/ORM базы нет. Очереди хранят команды и события максимум 7 дней.

## Развёртывание Vercel

1. Создать Vercel project из этого GitHub repository.
2. Установить Root Directory: `cloud`.
3. Включить Secure Backend Access / OIDC для проекта (Queues API принимает
   Vercel OIDC token функции).
4. Добавить Environment Variables из `cloud/.env.example`. Значения
   `TASKBRIDGE_WEB_SECRET` и `TASKBRIDGE_MACHINE_SECRET` должны быть разными,
   длинными и случайными. `QUEUE_REGION` должен совпадать для всех функций.
5. Выполнить deploy. Дальнейшие push в подключённую ветку деплоятся Git
   integration автоматически.

## Настройка ПК

В `config.json` добавить:

```json
{
  "cloud": {
    "enabled": true,
    "url": "https://your-taskbridge.vercel.app",
    "machineId": "home-pc",
    "machineSecretEnv": "TASKBRIDGE_MACHINE_SECRET",
    "eventFlushMs": 100,
    "pollIntervalMs": 1500,
    "maxBatchEvents": 100,
    "maxPayloadKb": 256,
    "maxOutboxMb": 100,
    "processedCommandLimit": 2000
  }
}
```

Перед запуском задать machine secret только через environment:

```powershell
$env:TASKBRIDGE_MACHINE_SECRET = 'тот-же-secret-что-в-vercel'
npm start
```

Секрет не нужно записывать в `config.json`.

## Надёжность

- событие сначала фиксируется в SQLite, затем попадает в
  `data/cloud/outbox.jsonl` с `event_<taskId>_<seq>`;
- `data/cloud/event-state.json` хранит последний загруженный `seq`; после
  аварийного рестарта пропущенный зазор дочитывается из SQLite;
- после сетевой ошибки outbox повторяется с тем же idempotency key;
- закрытые streaming-delta удаляются из batch, если рядом уже есть полный
  `message_end`;
- Queue command lease подтверждается только после локального принятия команды;
- последние command IDs сохраняются в `data/cloud/cloud-state.json`, поэтому
  повторный `START_TASK` не создаёт вторую задачу;
- браузер подтверждает event leases только после применения события и
  дедуплицирует task stream по `seq`.

Vercel Queues не гарантирует FIFO. Облачный UI сортирует события по локальному
`seq`; он не должен полагаться на порядок доставки.

## Ограничения MVP

- один пользователь и один настроенный ПК;
- без cloud file upload/download;
- cloud history ограничена TTL очереди (7 дней), локальная история — нет;
- при самом первом включении cloud старые event logs не выгружаются задним
  числом; Queue history начинается с момента включения (список старых задач
  всё равно приходит через `SYNC_STATE`);
- команды `FOLLOW_UP`/`COMPACT` выполняются at-least-once. Дубликаты уже
  завершённых command IDs отсекаются, но авария в очень узком окне между
  выполнением команды и записью `cloud-state.json` теоретически может повторить
  неидемпотентную команду;
- фактический end-to-end smoke требует Vercel project с включёнными Queues/OIDC
  и не выполняется локальным unit test.

## Проверка

```powershell
npm run check
npm test
```

Критический ручной сценарий: выключить TaskBridge на ПК, отправить START из
cloud UI, снова запустить TaskBridge и убедиться, что задача стартовала один раз.
