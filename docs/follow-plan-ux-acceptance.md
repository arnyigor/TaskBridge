# Follow Plan — приёмочная матрица (постоянный источник)

Этот файл фиксирует сценарии приёмки Follow Plan и результаты их последней проверки.
Номера не переиспользуются: новый сценарий получает новый номер, а не «освободившийся».

## Как читать статусы

| Статус | Значение |
|---|---|
| PASS | сценарий выполнен на реальном клиенте/сервере, есть артефакт (тест, скриншот, ответ API) |
| FAIL | воспроизведённый дефект; рядом — коммит с исправлением или пометка «открыт» |
| PARTIAL | проверена часть шагов, остальные перечислены словами |
| NOT_TESTED | не проверялось; **компиляция и сборка APK приёмкой не считаются** |

Проверки ведутся раздельно по клиентам: **Web**, **Desktop**, **Android**.
Один и тот же номер может быть PASS в Web и NOT_TESTED в Android — это нормальное
состояние, а не «общий PASS».

> Источник формулировок UX-01…UX-16: рабочая матрица приёмки FP-UX-02. Дословный
> нормативный текст из переписки восстановить не удалось (обсуждение было
> компактифицировано), поэтому ниже зафиксированы те определения, которые реально
> применялись при проверке. Если появится исходный текст — правится только колонка
> «Сценарий», номера остаются.

---

## UX-01…UX-16

| ID | Сценарий | Web | Desktop | Android | Артефакт |
|---|---|---|---|---|---|
| UX-01 | Файл, у которого все шаги DONE, читается как завершённый; запуск не предлагается | PASS | PASS | NOT_TESTED | `web-follow-plan-view.test.mjs` (`state-COMPLETED-start-off`), `DesktopFollowPlanAcceptanceTest` |
| UX-02 | Открытие панели прикреплённого плана: файл, ревизия, прогресс, текущий шаг | PASS | PASS | PASS | скриншоты `state-ready.png`, `01-panel-attached.png`, `10-plan.png` |
| UX-03 | Правка плана в редакторе и сохранение в тот же файл | PASS | PASS | PASS | редактор Web 11/11; desktop-тест (revision ≥ 2); Android revision 1→2 |
| UX-04 | Конфликт ревизий: внешняя правка не перезаписывается, черновик цел | PASS | PASS | NOT_TESTED | Chromium `ux02-editor-conflict.png`; desktop `06-conflict.png` |
| UX-05 | Несохранённый черновик: закрытие, повторное открытие, SSE во время правки | PASS | PASS | PARTIAL (правка не теряется при открытии клавиатуры; SSE-обновление не проверялось) | Web 11/11, desktop-тест |
| UX-06 | Следующий шаг отправляется только после фиксации хода | PASS | PASS | PASS | `follow-plan-service.test.mjs` (DISPATCH_READY → turnCommitted), desktop/Android RUNNING |
| UX-07 | Доступность действий по состоянию (READY/RUNNING/PAUSED/PAUSED_REVIEW/CONFLICT/COMPLETED/DISABLED) | PASS | PASS | PARTIAL (READY, RUNNING, PAUSED, PAUSED_REVIEW видел; CONFLICT/COMPLETED/DISABLED — нет) | Chromium 9 состояний 14/14 |
| UX-08 | Pause → Resume → STOP в интерфейсе | PASS | PASS | PARTIAL (Pause PASS; Resume/STOP через UI не подтверждены — касание попало в другую кнопку) | Chromium 14/14, desktop-тест |
| UX-09 | Отключение плана сохраняет файл | PASS | PARTIAL (detach вынесен в «Дополнительно» + подтверждение; само отключение в desktop-тесте не нажималось) | NOT_TESTED | Chromium 11/11 |
| UX-10 | Длинный план 30+ шагов: список раскрывается и прокручивается | PASS | PASS (32 шага в фикстуре, раскрытие/сворачивание) | NOT_TESTED (на устройстве было 2 шага) | `ux02-long32.png` |
| UX-11 | Два клиента: два Start/Resume, Resume против STOP, один dispatch | PASS (контроллер, детерминированные тесты) | PARTIAL (общий сервер с Web, но одновременные клики в одном прогоне не выполнялись) | NOT_TESTED | `plan-follower.test.mjs` гонки |
| UX-12 | Происхождение evidence: рукописные метки не дают доверия | PASS | PASS | PASS (общая серверная логика) | 11 отрицательных тестов + API-тест проводки |
| UX-13 | Сервер без нового API / потеря соединения: понятное сообщение | PASS | NOT_TESTED | NOT_TESTED | Chromium mock 404 + abort |
| UX-14 | Сервер с `followPlan.enabled=false` | PASS | NOT_TESTED | NOT_TESTED | реальный изолированный сервер + Chromium |
| UX-15 | Desktop GUI: выбор файла, управление, прокрутка, отсутствие наложения диалогов | PASS (композиция production `App()` в Compose UI test) | — | — | `DesktopFollowPlanAcceptanceTest`, 6 скриншотов |
| UX-16 | Android GUI: выбор файла, фон/возврат, клавиатура, скролл, конфликт | PARTIAL (см. ниже) | — | — | 21 скриншот `android/*.png` |

### UX-16 детально (Android, Pixel 5 API 31, эмулятор)

| Шаг | Статус | Доказательство |
|---|---|---|
| Подключение к серверу, открытие сессии | PASS | `04-reconnect.png` … `06-session.png` |
| Открытие панели плана | PASS | `10-plan.png` |
| Раскрытие списка шагов | PASS | `11-running.png` |
| Start → RUNNING | PASS | `11-running.png` + `план.state=RUNNING_STEP` |
| Pause → PAUSED | PASS | API `state=PAUSED` |
| Редактор: чтение серверного файла, revision 2 | PASS | `14-editor.png`, `21-editor-ime.png` |
| Сохранение правки | PASS | `revision 1→2` по API |
| Диалог с открытой клавиатурой | **FAIL → исправлено** | `16-full.png` (кнопки за клавиатурой) → `21-editor-ime.png` (кнопки видны) |
| Фон → возврат | PASS | force-stop + запуск: панель в PAUSED, состояние сервера сохранено |
| Resume, STOP через UI | NOT_TESTED | касание попало в соседнюю кнопку |
| Системный выбор файла (SAF), файл на телефоне | NOT_TESTED | не выполнялось |
| Конфликт ревизий на Android | NOT_TESTED | не выполнялось |
| SSE reconnect | NOT_TESTED | не выполнялось |
| План 30+ шагов на устройстве | NOT_TESTED | на устройстве был план из 2 шагов |

---

## NATIVE-01…NATIVE-08 (Desktop)

Выполняется `DesktopFollowPlanAcceptanceTest` — **production-композиция**
`App(graph, openTaskId=…)` на настоящем сервере (`tests/fixture-server-plan.mjs`,
`followPlan.enabled=true`), настройки в памяти. Окно оператора и его Java-настройки
не затрагиваются.

| ID | Сценарий | Статус | Как проверено |
|---|---|---|---|
| NATIVE-01 | Выбор файла и подключение плана | PASS | «Сканировать проект» → строка `PLAN.md` → вердикт «Готов к подключению» → «Подключить» → `attached=true`, `path=PLAN.md`; ручного поля пути в панели нет (FP-UX-03) |
| NATIVE-02 | Просмотр файла плана | PASS | панель показывает файл, ревизию, прогресс, шаг |
| NATIVE-03 | Правка, сохранение, CAS-конфликт | PASS | конфликт после внешней правки; «Отменить изменения»; adopt → сохранение, revision ≥ 2 |
| NATIVE-04 | Состояние RUNNING | PASS | шаг `slow` в фикстуре: `RUNNING_STEP`, кнопка «Пауза после шага» |
| NATIVE-05 | Pause, Resume, STOP | PASS | PAUSED → «Продолжить» → RUNNING_STEP → STOP → PAUSED_REVIEW |
| NATIVE-06 | Сворачивание/раскрытие списка шагов | PASS | «Все шаги (2)» ⇄ «Скрыть шаги» |
| NATIVE-07 | Меню «Дополнительно», отсутствие наложения диалогов | PASS | «Отключить план» отсутствует в ряду, появляется в меню; меню закрывается до следующего действия; один диалог за раз |
| NATIVE-08 | Черновик при обновлениях статуса | PASS | обновление статуса во время правки не меняет текст (`assertTextContains`) |

Скриншоты: `.local/fp-06/desktop/screens/01-panel-attached.png` … `06-conflict.png`.

---

## Локальные файлы Windows (CAS под внешним редактором)

Проверено тестами (не «на глаз»):

- `plan-file.test.mjs`: внешняя правка между чтением и `rename` → `PLAN_REVISION_CONFLICT`,
  файл оператора сохранён, `.tmp` не остаётся.
- `follow-plan-service.test.mjs`: 6 одновременных сохранений на одной CAS-базе → ровно
  один победитель, revision +1.
- `plan-follower.test.mjs`: Start/Resume против STOP/Detach при отпускании ожидания чтения.

**Граница гарантии.** TaskBridge не заявляет абсолютную атомарность с произвольным
внешним редактором: сериализация записей действует внутри одного процесса
(`withPlanWriteLock`), а окно между проверкой хэша и `rename` только сужено —
Windows не предоставляет файлового compare-and-swap. Внешняя правка, попавшая
в это окно, не будет перезаписана молча только если она попала до проверки;
после проверки и до `rename` она может быть потеряна. Это ограничение платформы,
а не скрытый дефект.

---

## Решение

**GO для ограниченного выпуска** — при условиях, перечисленных в
`.local/fp-06/FP-UX-02-final-report.md` (раздел «Решение GO/NO-GO»):
Desktop и Web приёмка пройдена, Android — с явно перечисленными NOT_TESTED
(системный picker, конфликт на устройстве, SSE reconnect, Resume/STOP через UI).

---

## FP-UX-04 — выбор плана со сканированием проекта (DISC / VALID / AI / UX)

Источник требований: `docs/FP-UX-04-PLAN.md`. Сканирование — отдельный маршрут
`POST /api/tasks/:id/plan/scan` (`src/application/plan-scan.mjs`), вердикт файла —
`classifyPlan` (`src/application/plan-file.mjs`), проверка ИИ —
`POST /api/tasks/:id/plan/ai-review` (`src/application/plan-ai-review.mjs`).

| ID | Сценарий | Статус | Артефакт |
|---|---|---|---|
| DISC-01 | Открытие диалога не запускает сканирование | PASS (web, android, desktop) | `web-follow-plan-view.test.mjs` (`openPlanDialog` без запроса); Chromium: ноль запросов `/plan/scan` до нажатия; Android: список появляется только по кнопке |
| DISC-02 | Одно нажатие — один поиск | PASS | `web-follow-plan-view.test.mjs` (обработчик `planScanStart` → один `runPlanScan`), `runScan` с защитой `scanBusy` |
| DISC-03 | Находятся вложенные Markdown-файлы | PASS | `plan-discovery.test.mjs`, `follow-plan-api.test.mjs` |
| DISC-04 | Список содержит файлы, а не папки | PASS | `plan-discovery.test.mjs`, `planScanRows` |
| DISC-05 | Поиск фильтрует имя и относительный путь | PASS | `plan-discovery.test.mjs` (сервер), `planScanRows` (клиент, без повторного сканирования) |
| DISC-06 | Служебные каталоги не тормозят проект | PASS | `plan-discovery.test.mjs` (`node_modules`/`build`/`dist`/`.git`/`.local`/`.gradle`) |
| DISC-07 | Symlink/junction наружу не обходится | PASS | `plan-discovery.test.mjs` (junction на Windows) |
| DISC-08 | Повторный поиск обновляет результаты | PASS | `plan-discovery.test.mjs` |
| VALID-01 | Корректный управляемый PLAN.md | PASS | `plan-discovery.test.mjs`, `follow-plan-api.test.mjs` |
| VALID-02 | README/AGENTS не подключаются без структуры | PASS | `plan-discovery.test.mjs` (вердикт и отказ импорта) |
| VALID-03 | Неуправляемый TODO получает предложение преобразования | PASS | `plan-discovery.test.mjs` (предпросмотр содержимого, файл не изменён) |
| VALID-04 | Пустой и повреждённый файл отклоняются | PASS | `plan-discovery.test.mjs` |
| VALID-05 | Ошибка преобразования не уничтожает исходный текст | PASS | `plan-discovery.test.mjs` |
| VALID-06 | Внешняя правка между preview и attach обнаруживается | PASS | `plan-discovery.test.mjs`, `follow-plan-api.test.mjs`: `inspect` отдаёт хэш, `import` отвечает `PLAN_REVISION_CONFLICT` и файл не перезаписывает |
| AI-01 | ИИ-проверка не запускается автоматически | PASS | `plan-discovery.test.mjs` (сканирование, проверка и attach модель не спрашивают) |
| AI-02 | Отказ модели не блокирует валидный план | PASS | `plan-discovery.test.mjs`, `follow-plan-api.test.mjs` (фикстура без модели) |
| UX-01 | Отмена выбора возвращает стартовый экран | PASS (web, android) | `cancelPlanSelection` ничего не удаляет; Chromium и Pixel 5: после отмены видны обе кнопки и «План не подключён» |
| UX-02 | Detach возвращает стартовый экран, файл сохранён | PASS (web, android, desktop) | Chromium и Pixel 5: `attached=false`, файл 729 байт на месте; desktop-тест: detach и повторное подключение |
| UX-03 | STOP при активном плане не допускает автопродолжение | PASS (прежние тесты) | `plan-follower.test.mjs`, `follow-plan-service.test.mjs` |
| UX-04 | Desktop native picker работает как прежде | PARTIAL | desktop-приёмка проходит через сканирование; нативный picker — только при `TASKBRIDGE_NATIVE_PICKER_SMOKE=1` (не запускался) |
| UX-05 | Android SAF работает как прежде | PARTIAL | DocumentsUI открывается по «Открыть файл» и показывает `.md`; выбор конкретного файла в этом прогоне не завершался |
| UX-06 | Web picker и серверное сканирование — разные источники | PASS | web: `input type=file` → base64; список — `POST /plan/scan`; KMP: SAF/FileDialog → путь внутри workspace либо содержимое |

### Результаты приёмки FP-UX-04 (2026-10-24)

- **Web, Chromium** (изолированный сервер, песочница `.local/fp-ux-04/stand.mjs`):
  26/26 проверок — обе кнопки, ноль запросов scan до нажатия, плоский список из 24
  файлов, фильтр по имени и пути без нового сканирования, вердикты
  `CONVERTIBLE`/`NOT_A_PLAN`/`VALID_MANAGED`, подключение без хода Pi
  (`runs 1 → 1`), detach с сохранением файла, системный выбор файла открывается.
- **Android, Pixel 5 API 31** (эмулятор, adb + uiautomator, debug APK): панель
  компактная, обе кнопки в одной строке, 24 файла в прокручиваемом списке, поиск с
  открытой клавиатурой, выбор `docs/PLAN.md`, подключение (шаги 0/2, `runs 1 → 1`),
  фон → возврат без потери состояния, detach и возврат к двум кнопкам, «Открыть
  файл» открывает DocumentsUI, «Отменить выбор» возвращает стартовое состояние.
- **Desktop, production Compose UI** (`DesktopFollowPlanAcceptanceTest`): сканирование,
  выбор вложенного `docs/PLAN.md`, подключение, detach с сохранением файла,
  повторное подключение — тест проходит.

Найдено и исправлено в ходе приёмки (не «по аналогии», а воспроизведено):

1. **Android: карточка выбора была недостижима.** Внутри `AlertDialog` список и
   карточка вердикта не помещались, карточка рисовалась ниже видимой области —
   кнопки «Подключить» на телефоне не существовало. Панель переведена на
   `Dialog` + `Surface` с фиксированным заголовком/футером, карточка заменяет
   список на время выбора.
2. **Android: две кнопки старта переносились и обрезались** («Сканировать п…»).
   `FlowRow` заменён на `Row` с `weight` и компактными отступами.
3. **Web: кнопки карточки выбора уезжали за нижнюю границу окна** (список занимал
   весь диалог). Панель выбора сжимается и прокручивается, карточка и футер —
   фиксированные; проверяется координатами кнопки в Chromium.
4. **Внешняя правка между предпросмотром и attach не обнаруживалась**: сервер
   применял вердикт к уже другому тексту. `inspect` теперь возвращает хэш
   показанного текста, `import` сверяет его и отвечает `PLAN_REVISION_CONFLICT`.

Полный регрессионный gate после изменений: `npm test` — 1625 тестов, 0 падений;
KMP `:shared:jvmTest` — 293 теста, 0 падений.

**Остаточные ограничения (не PASS):**

- UX-04 (нативный системный выбор файла на Desktop): desktop-приёмка идёт через
  сканирование; нативный диалог запускается только с
  `TASKBRIDGE_NATIVE_PICKER_SMOKE=1` и в этом прогоне не проверялся.
- UX-05 (Android SAF): выбор файла в DocumentsUI открывается и показывает `.md`,
  но выбор конкретного файла в этом прогоне не завершался — PARTIAL.
- «Удалить файл с сервера» (FP-UX-04F) намеренно отсутствует: файл плана —
  исходный файл проекта, и отдельной кнопки удаления в интерфейсе нет.
