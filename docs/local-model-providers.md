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

Встроенный `llama.cpp` можно использовать, только задав
`LLAMA_BASE_URL=http://127.0.0.1:8080` (env) или сделав `/login llama.cpp`;
тогда рукописный `llamacpp` можно удалить.

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
