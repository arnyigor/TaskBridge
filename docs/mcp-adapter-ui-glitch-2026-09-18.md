# Глюк Pi + MCP: строка «MCP: N direct tools resolved» и «нужно установить playwright»

Дата разбора: 2026-09-18. Стенд: pi-coding-agent 0.85.1, pi-mcp-adapter 2.34.0,
конфиг MCP — `C:\Users\ArnyPC\.pi\agent\mcp.json`.

## 1. Что за глюк на скриншоте

На фото видна одна длинная строка под спиннером «Working»:

```
MCP: 82 direct tools resolved. Each direct tool adds prompt context; README guidance
recommends targeted sets of 5-20 tools and using the proxy or an explicit string[]
when 75+ direct tools would be registered. Set settings.warnOnLargeDirectTools to false
to hide this advisory.
```

Это **не ошибка установки и не сбой MCP**. Это предупреждение расширения
`pi-mcp-adapter`, напечатанное через обычный `console.warn`:

- `~/.pi/agent/npm/node_modules/pi-mcp-adapter/direct-tool-surface.ts:194-196`
  ```ts
  const eagerCount = emittedSpecs.filter((spec) => !spec.lazy).length;
  if (config.settings?.warnOnLargeDirectTools !== false && eagerCount >= DIRECT_TOOLS_ADVISORY_THRESHOLD) {
    console.warn(`MCP: ${eagerCount} direct tools resolved. ...`);
  }
  ```
- Порог: `DIRECT_TOOLS_ADVISORY_THRESHOLD = 75` (`direct-tool-surface.ts:11`).
- Проверка числа по вашему конфигу (все серверы включены) даёт **ровно 82**:

  | сервер | directTools | инструментов |
  | --- | --- | --- |
  | chrome-devtools | `true` | 29 |
  | dependency-doctor | `true` | 16 |
  | mcpServer | массив | 14 |
  | figma-local | `true` | 6 |
  | artemis | массив | 5 |
  | project-md | `true` | 5 |
  | web-search | `true` | 3 |
  | context7 | `true` | 2 |
  | image-description-engine | `true` | 1 |
  | deepseek-web | `true` | 1 |

  Итого 82 — цифра из скриншота совпадает.

### Почему от этого «ломается вёрстка в поле ввода»

`console.warn` пишет в stdout напрямую, минуя TUI-рендерер. В pi 0.85.1
подмены `console.*` нет (проверено: ни `patchConsole`, ни переприсваивания
`console.log`/`console.warn` в `dist/**/*.js` не найдено), поэтому строка
печатается в терминал поверх кадра. Длина строки ~291 символ — это 3–4 строки
на типичной ширине терминала, кадр под ними не перерисовывается, и поле ввода
(и строка `cwd (branch)` под ним) уезжает/рисуется поверх мусора — то, что на
фото видно как «сломанная вёрстка поля ввода».

Дополнительно: та же строка ломает RPC-канал TaskBridge. В `--mode rpc` stdout —
это JSONL-протокол (`src/pi-rpc.mjs:116-122`), не-JSON строка превращается в
событие `PI_PROTOCOL_ERROR` (`src/task-manager.mjs:930`) — задача при этом
рабочая, но в логе каждой задачи висит «ошибка протокола».

### Как убрать

1. Быстро (одна строка) — в `~/.pi/agent/mcp.json`:

   ```json
   {
     "mcpServers": { "...": {} },
     "settings": { "warnOnLargeDirectTools": false }
   }
   ```

   Флаг читается из `settings` и из `--mcp-config`-файла
   (`pi-mcp-adapter/config.ts`, `getMergedSettings(overridePath)` → merge
   `loaded.settings`), тип — `types.ts:607`.

2. По существу — вернуть число direct-инструментов в рекомендуемые 5–20:
   - редко используемым серверам ставить `"directTools": "search"`
     (lazy-режим; такие инструменты **не** считаются в advisory, см. CHANGELOG 2.34.0);
   - или перечислять нужные имена массивом (как сделано для `mcpServer`, `artemis`);
   - самые «жирные» кандидаты на срез: `chrome-devtools` (29!),
     `dependency-doctor` (16), `project-md` (5), `figma-local` (6).

В TaskBridge сделано то же для файла, которым владеет она сама (см. «Что
изменено»): в терминале Pi это не помогает, потому что там используется
`~/.pi/agent/mcp.json`.

## 2. «Показывает, что что-то нужно установить» при MCP-поиске в Яндексе

Это **текст самого инструмента**, а не сообщение UI:

- описание: `[SLOW] [NETWORK] [REQUIRES_SETUP] Поиск в Яндексе через Playwright
  (видимый браузер) … Требует: playwright install на хосте.`
  (`G:\AIModels\MCPs\McpServer\src\mcp_tools\web.py:40-45`);
- аварийный ответ бэкенда: `❌ Error: Yandex Playwright backend is unavailable.
  Install playwright and run \`playwright install\`.` (`web.py:58`);
- собственный лог: `Playwright not installed. Run: pip install playwright &&
  playwright install` (`src/search/yandex.py:147`).

То есть «нужно установить» появляется в чате каждый раз, когда бэкенд не
поднялся (импорт Playwright или запуск браузера), а не когда пакета нет.

Фактическое состояние хоста на момент разбора: в venv MCP-сервера стоит
`playwright 1.60.0`, а в `C:\Users\ArnyPC\AppData\Local\ms-playwright` есть
`chromium-1223` — ровно та ревизия, которую требует 1.60.0, и инструмент
запускает браузер headful (`headless=False`). `chromium_headless_shell-1223`
при этом отсутствует — headless-запуск той же ревизии упал бы.

Вывод: сообщение об установке — вводящее в заблуждение fallback. Перед
переустановкой Playwright смотреть stderr MCP-сервера (`pi.stderr.log` задачи
через `PI_STDERR`): реальная причина обычно в самой попытке `launch`.

### «Вёрстка ломается» — та же природа

Ломается не от текста про установку как такового, а от любого неразрывного
длинного токена/сырой строки в узком месте интерфейса. В веб-чате TaskBridge
это два места, где раньше не было точки переноса:

- `.hint` (строка-подсказка/ошибка под полем ввода, `web/app.css:997`) —
  `white-space: pre-wrap` без `overflow-wrap`, а туда попадают тексты ошибок с
  длинными Windows-путями (например из `McpManager.importFromPi`:
  «Не удалось прочитать C:\Users\…\mcp.json: …»);
- `#activity` (полоса состояния, `web/app.css:827`) — в неё подставляется
  `task.model.id`, то есть один неразрывный токен вида
  `llamacpp/qwen3-…-Q4_K_M`.

Оба места теперь получают `overflow-wrap: anywhere` (+ `min-width: 0` для
flex-строки статуса), поэтому длинный токен переносится, а не растягивает
composer.

## 3. Главная находка: сырой stderr MCP-сервера (скриншоты 2-3)

На двух свежих скриншотах в консоль вывален весь `console.error` сервера
`web-search` вместе со стек-трейсами и рамкой самого Playwright:

```
[SearchEngine] Browser Brave browser error (attempt 1): browserType.launch:
  Executable doesn't exist at C:\Users\ArnyPC\AppData\Local\ms-playwright\...
╭───────────────────────────────────────────────────────────╮
│ Looks like Playwright Test or Playwright was just installed │
│ or updated. Please run the following command ...            │
│   npx playwright install                                    │
╰───────────────────────────────────────────────────────────╯
[BrowserPool] Failed to launch firefox browser: ...
[EnhancedContentExtractor] Browser extraction also failed: ...
    at BrowserPool.getBrowser (G:\AIModels\MCPs\web-search-mcp\dist\browser-pool.js:76:45)
```

Причина, по которой это вылезает **в терминал Pi**, а не в лог:

```ts
// pi-mcp-adapter/server-manager.ts:916
stderr: definition.debug ? "inherit" : "pipe",
```

`types.ts:484` / README:329 — `debug: "Show server stderr (default: false)"`.
В `~/.pi/agent/mcp.json` у сервера `web-search` стоит **`"debug": true`**,
поэтому stderr дочернего процесса наследуется терминалом и печатается прямо
поверх TUI (в скриншотах видно «⋯ Working» внутри этого мусора).

При `debug: false` адаптер сам забирает stderr в кольцевой буфер
(`server-manager.ts:163-171`), хранит последние `MAX_CAPTURED_STDERR_LINES = 3`
строки / 8 КБ и подклеивает их **в текст ошибки**, а не в терминал
(`server-manager.ts:1066-1073`).

### Почему сервер вообще падает

`web-search-mcp` использует **свой** Playwright 1.54.2
(`node_modules/playwright`), которому нужны ревизии `chromium-1181`,
`chromium-headless-shell-1181` и `firefox-1489`. В
`C:\Users\ArnyPC\AppData\Local\ms-playwright` лежат только
`chromium-1200/1223/1228/1234`, `chromium_headless_shell-1200/1228/1234`,
`ffmpeg-1011`, `winldd-1007` — **ни 1181, ни firefox нет вообще**. Отсюда
«Executable doesn't exist», две попытки (chromium + firefox —
`BROWSER_TYPES` по умолчанию `chromium,firefox`, `dist/browser-pool.js:14`)
и полный трейс в ошибке. Сообщение «Please run `npx playwright install`» — это
встроенный текст ошибки Playwright, и в данном случае он **прав**: браузеров
этой ревизии действительно нет.

### Что делать (по порядку)

1. Выключить поток stderr на сервере — в `~/.pi/agent/mcp.json` у `web-search`
   убрать `"debug": true` (или поставить `false`). Одна правка убирает из TUI
   и рамку Playwright, и все стек-трейсы.
2. Доустановить браузеры для этой версии Playwright:

   ```powershell
   cd G:\AIModels\MCPs\web-search-mcp
   npx playwright install chromium firefox      # ~300-400 МБ в %LOCALAPPDATA%\ms-playwright
   ```

   Если firefox не нужен — в `env` сервера добавить `"BROWSER_TYPES": "chromium"`
   и ставить только chromium.
3. (Необязательно, гигиена) `web-search-mcp` логирует всё безусловным
   `console.log`/`console.error` — настроек «тише» в нём нет, единственный
   рычаг — п.1 (и не доводить до ошибок п.2).
4. Advisory про 82 инструмента — раздел 1 (pin + сократить direct-инструменты).
5. Заодно: `mcpServer` (`search_yandex_playwright`) идёт по тому же пути —
   у него в venv `playwright 1.60.0` и есть `chromium-1223`, но нет
   `chromium_headless_shell-1223`; если переключить его на headless, снова
   получим «Executable doesn't exist».

## Что изменено в этом репозитории

| Файл | Изменение |
| --- | --- |
| `src/mcp-manager.mjs` | `PINNED_SETTINGS = { warnOnLargeDirectTools: false }` + `withPinnedSettings()`; применяется последним в `write()`, поэтому импортированный `true` не перебивает pin. Pi-конфиг по-прежнему только читается. |
| `web/app.css` | `.hint` → `overflow-wrap: anywhere`; `#activity` → `min-width: 0; overflow-wrap: anywhere`. |
| `tests/mcp-manager.test.mjs` | Тест: pin ставится в managed-конфиг, пользовательские `settings` сохраняются, pin выживает `setDisabled`/`write`, конфиг Pi не переписывается; off-режим остаётся пустым. |
| `docs/mcp-adapter-ui-glitch-2026-09-18.md` | Этот разбор (три причины: advisory 75+, текст «install» от инструмента и наследованный stderr при `debug: true`). |

Что **не** сделано намеренно: `~/.pi/agent/mcp.json` не менялся (это конфиг
самого Pi, а не проект); `debug: true` в imported-конфиге TaskBridge не
вырезается — там stderr уходит в `pi.stderr.log` задачи (`PI_STDERR`), то есть
приносит пользу; веб-интерфейс TaskBridge не стал фильтровать
`PI_PROTOCOL_ERROR` — строку проще не допускать (pin), чем прятать симптом.

## Проверки

```
npm run check                          # node --check по всем модулям
node --test tests/mcp-manager.test.mjs # 9/9 pass
```

Воспроизведение глюка (для проверки, что pin работает): временно вернуть
`"warnOnLargeDirectTools": true` в `~/.pi/agent/mcp.json`, включить все MCP-серверы
и запустить `pi` в терминале — строка печатается сразу при регистрации
direct-инструментов. При `false` строка не появляется.
