# Локальные провайдеры Pi: id `llamacpp` и `llama.cpp`

Заметка о граблях, на которые уже наступали. Касается связки **Pi ↔ локальный
llama.cpp** и того, какой id провайдера TaskBridge передаёт в Pi.

## Что столкнулось

Pi имеет **встроенное** расширение llama.cpp (`builtInExtensions`, провайдер с
id `llama.cpp`). Его `auth.apiKey.resolve` берёт адрес из `LLAMA_BASE_URL` (env)
или из `/login llama.cpp`, а без адреса возвращает `undefined`.

Если в `~/.pi/agent/models.json` рукописный провайдер назван **так же** —
`llama.cpp`, — встроенный провайдер подменяет базовый слой, и его `resolve`
вызывается с «поддельным» креденшлом без `LLAMA_BASE_URL` → `undefined`.

Симптомы ровно такие:

```
pi auth check --provider llama.cpp   → {"status":"ready"}   # проверяет только models.json
pi --list-models                     → модели видны
запрос                               → Error: Provider is not configured: llama.cpp
```

## Правило именования (действует сейчас)

- Рукописный провайдер в `models.json` называется **`llamacpp`** — без коллизии
  со встроенным `llama.cpp`.
- `baseUrl: http://127.0.0.1:8080/v1`, `api: openai-completions`,
  `apiKey: llamacpp`.
- **id моделей = имена пресетов из `models.ini`** (`qwen-27b-q3`,
  `qwen-27b-q3-vision`, …). Иначе llama.cpp-роутер отвечает
  `400 model not found`: id в Pi и в пресетах должны совпадать.
- У каждой модели — `thinkingLevelMap` и
  `compat.thinkingFormat: "chat-template"` + `chatTemplateKwargs`.

Встроенный `llama.cpp` работает, если задать адрес одним из двух способов:

1. `LLAMA_BASE_URL=http://127.0.0.1:8080` в окружении (TaskBridge выставляет его,
   когда у него включён router-режим), или
2. креденшл в `~/.pi/agent/auth.json` —
   `llama.cpp = { type: "api_key", key: "llamacpp", env: { LLAMA_BASE_URL: "http://127.0.0.1:8080" } }`,
   что эквивалентно `/login llama.cpp` и не зависит от env запускающего процесса.

### Решение: остаётся только `llama.cpp` (11 сентября 2026)

Принято и проверено: рукописный `llamacpp` **удалён**, работает встроенный
`llama.cpp`. Почему:

- это встроенный провайдер Pi — нативная интеграция с llama.cpp-роутером: живой
  список моделей, `/llama`, автозагрузка пресетов;
- он же записан в `Taskbridge/config.json` (`localRuntime.provider: "llama.cpp"`)
  и во все свежие сессии (`model_change → llama.cpp/qwen-27b-*`);
- аутентификация персистентная: креденшл в `auth.json`
  (`env.LLAMA_BASE_URL`), плюс TaskBridge сам отдаёт `LLAMA_BASE_URL`, когда
  включает router-режим;
- дубль `llamacpp` давал путаницу с id (его модели `Qwen3.8-27B-UD-*` роутер не
  знает) и лишние строки в селекторе.

После удаления: `pi --list-models` → 4 модели `llama.cpp`,
`pi auth check --provider llama.cpp` → ready, сквозной запрос проходит.

Бэкап: `~/.pi/agent/models.json.bak-before-drop-llamacpp`.

Код TaskBridge при этом **не требует правки**: `resolveLocalProviderId()`
возвращает настроенный id, когда Pi его отдаёт, а терпимость к `llamacpp`
остаётся страховкой на случай старой установки.

### Старые id моделей (`qwen3.8-27b-q3`)

Это не про провайдеров: id зашит в старых сессиях (`model_change`) и в
`~/.pi/agent/sessions/...`. Роутер знает только имена пресетов из
`Taskbridge/models.ini`, поэтому такой запрос отвечает `400 model not found`.

Два способа лечения:

1. в чате Pi: `/model` → `llama.cpp/qwen-27b-q3` (или начать новый чат) — то есть
   «пересесть» на актуальный пресет;
2. если старый id нужно принимать и дальше — только на стороне TaskBridge, в
   `models.ini` у секции `[qwen-27b-q3]` добавить `alias = qwen3.8-27b-q3` и
   перезапустить `llama-server` (ini читается при старте/переподключении).

## Что должен делать TaskBridge

1. **Гейт локального рантайма терпим к обоим id.** `usesLocalRuntime()` считает
   локальным и `llamacpp`, и `llama.cpp`, если `localRuntime.provider` — один из
   них. Поэтому `localRuntime.provider: "llama.cpp"` в `config.json` сам по себе
   ничего не ломает.
2. **Но id, который уходит в Pi, должен существовать у Pi.**
   `resolveLocalProviderId()` (`src/dispatcher.mjs`) берёт
   `localRuntime.provider`, сверяет с каталогом Pi из `modelCatalog` и, если
   настроенного id там нет, возвращает тот локальный id, который Pi
   действительно отдаёт (предпочитая `llamacpp`). Каталог ещё не прогрет —
   возвращается настроенный id (прежнее поведение).
3. Этот id используется везде, где TaskBridge предлагает или выбирает модель:
   - `localStatus()` → `provider` в `/api/local` (UI берёт id оттуда:
     `localProviderId()` в `web/app.js`);
   - авто-выбор пресета в router-режиме (`resolveRouterModel`);
   - фолбэк на модель Pi по умолчанию (`#localModelFor`).
4. Каталог Pi прогревается по-разному: `GET /api/local` (окно «Локальные
   модели», действие пользователя) при пустом кэше один раз опрашивает Pi,
   чтобы id был верным; опрашиваемый каждые несколько секунд `/api/info` этого
   не делает и обходится кэшем (иначе каждый опрос поднимал бы процесс Pi).

Итог: смена имени провайдера в Pi не требует правки `config.json` — TaskBridge
подстраивается по каталогу Pi. Тесты: `tests/local-provider-id.test.mjs`.

## Если модель «не найдена» в picker'е

Проверить по порядку:

1. id модели в `models.json` совпадает с именем пресета в `models.ini`;
2. `pi --list-models llamacpp` показывает ожидаемые модели;
3. `curl http://127.0.0.1:8080/v1/models` отвечает (роутер запущен);
4. в `/api/local` (или в окне «Локальные модели») `provider` — тот же id, что
   показывает Pi.
