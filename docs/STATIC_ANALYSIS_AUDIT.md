# TaskBridge — Static Analysis & Quality Audit (Phase A, 2026-11-20)

Аудит без исправлений. Инструменты: Detekt 1.23.7 (CLI), ktlint 1.3.1, ESLint 9.39.5, Android Lint (AGP 9.1.1). Обновления Kotlin/Gradle/Compose не выполнялись (по ограничению).

## 1. Конфигурации

- `config/analysis/detekt-config.yml` + `clients/kmp/config/analysis/detekt-baseline.xml` (2269 существующих нарушений зафиксированы; `maxIssues: 0` — **новые нарушения блокируют**, старые не прячутся). CLI-команда:
  `java -jar detekt-cli.jar --input <source sets> --baseline clients/kmp/config/analysis/detekt-baseline.xml`
- `eslint.config.mjs` + `npm run lint:js` (web/*.js, flat config, recommended-правила).
- ktlint CLI — используется как внешний инструмент (отчёт в `.local/analysis/ktlint-report.txt`), в Gradle не встроен.
- Android Lint: `./gradlew :androidApp:lintDebug` (отчёт `androidApp/build/reports/lint-results-debug.txt`).

## 2. Сводка

| Анализатор | Нарушений | Критичных для надёжности |
|---|---|---|
| Detekt (Kotlin, все src sets) | 2250 (после нормализации записи) | 26 (см. ниже) |
| ktlint (Kotlin, стиль) | ~65k строк отчёта (преимущественно форматирование: indent/wrapping/trailing-comma) | 0 |
| ESLint (JS: web, scripts, src, tests, cloud) | 128 (web: 6 файлов) | 4 (no-self-assign, no-empty, 2 no-unused-vars) |
| Android Lint | 25 | 1 Error (PropertyEscape в `local.properties` — машинный файл, не в git) |

Распределение Detekt по правилам: MaxLineLength 1397, MagicNumber 524, FunctionNaming 169, ReturnCount 70, WildcardImport 27, TooGenericExceptionCaught 15, LoopWithTooManyJumpStatements 9, UseCheckOrError 8, SwallowedException 3, UnusedPrivateMember/Property 6.

## 3. Топ-20 значимых проблем (по риску, не по количеству)

Все пути от `clients/kmp/`, если не указано иное.

1. `core/client/.../ChatActionRunner.kt:60` — **TooGenericExceptionCaught**: общий `catch (Exception)` → `ApiError.Unreachable` «нет связи» — может маскировать реальные ошибки (после фикса BUG-P0 диалогового пути; нужен раздельный catch по классам ошибок).
2. `core/client/.../ChatSession.kt:376` — **TooGenericExceptionCaught** в цикле доставки.
3. `core/client/.../ChatSession.kt:490` — **SwallowedException**: проглоченная ошибка без лога.
4. ✅ ПРОВЕРЕНО 2026-11-20, изменений не требуется: generic catch в `TaskBridgeApi.kt` — это транспортная обёртка SSE/HTTP: `ApiException` и `CancellationException` пробрасываются как есть, обёртка в `Unreachable(cause)` применяется только к реальным транспортным отказам (не-Api исключениям) и сохраняет причину в `cause`. Классификация корректна, менять поведение без отдельной задачи нельзя.
5. `core/client/.../RemoteFilesController.kt:104,119` — generic catch вокруг мутаций файлов.
6. `core/client/.../SessionList.kt:385,409` — **UseCheckOrError** (`error()`) в путях восстановления — проверить текст отказов.
7. `core/client/.../ChatReducer.kt` — 0 критичных Detekt, но: класс обязателен к сохранению поведения — покрыт реплей-тестами (EditResendTextLossTest, EditLifecycleTest, EditResendReplayTest). Любое изменение — только с их прогоном.
8. `src/ProjectMemory.kt:62,81`, `ProjectWorkspace.kt:95,129` — generic catch в серверной работе с файлами (Node).
9. `shared/.../ImageSaver.android.kt:36`, `Platform.android.kt:353,407`, `PowerSection.kt:232` — generic catch на Android-платформе.
10. `core/client/.../SessionList.kt` — длинные фоновые циклы (LoopWithTooManyJumpStatements 9 мест суммарно в репо) — проверить, что `continue` не съедает обработку ошибок.
11. web/app.js: `no-self-assign` (реальный код-смелл), `no-empty` ×3, `no-unused-vars` ×9 — реальные, но локальные.
12. web/app.js: `no-undef` ×115 — в основном шум от неполного списка browser-globals в конфиге (EventSource, WebSocket и пр.) — дообогатить globals, не трогая код.
13. Android Lint `InsecureBaseConfiguration` — WebView без базовой проверки (проверить применение).
14. Android Lint `DataExtractionRules` — нет правил извлечения данных (бэкап Android).
15. Android Lint `ObsoleteSdkInt` — устаревшие проверки версий SDK.
16. `ReturnCount` ×70 — длинные функции с множеством выходов (ChatScreen/ChatReducer) — косвенный признак сложности, править адресно.
17. `WildcardImport` ×27 — мешает контролю зависимостей в ядре.
18. `UnusedPrivateMember/Property` ×3 — мёртвый код после рефакторингов — удалить адресно.
19. `EmptyElseBlock` ×2 — пустые ветки — проверить намеренность.
20. ktlint: массовые нарушения форматирования (indent/wrapping) — исправлять только автоформатированием по папкам в отдельных коммитах (Фаза C), не смешивать с функциональными правками.

## 4. План безопасного исправления (маленькие коммиты)

| Шаг | Содержание | Защита |
|---|---|---|
| 1 | ESLint: дополнить browser-globals (убрать шум no-undef), включить `npm run lint:js` в CI | diff только конфига |
| 2 | `TaskBridgeApi.kt` — раздельные catch: транспорт (Unreachable) / HTTP-код / декодирование; лог причин. Прогон: существующие тесты + edit-queue | типы ошибок не меняются |
| 3 | `ChatActionRunner.kt:60`, `ChatSession.kt:376,490` — детализация исключений доставки | ChatDeliveryRegressionTest + EditLifecycleTest |
| 4 | Удалить мёртвый код (3 места), поправить EmptyElseBlock | compile + тесты |
| 5 | Android Lint: DataExtractionRules, InsecureBaseConfiguration — отдельная задача с ревью поведения WebView | ручная проверка |
| 6 | ktlint автоформат по директориям (chat → api → screens) — по одному коммиту на директорию | полный тестовый baseline после каждого |

## 5. Тестовый baseline до/после

- До: `:core` 180 тестов / 5 ранее существовавших падений (`RemoteFilesControllerTest`); `:shared` — 0 упавших; node — 1686/1696 pass (6 ранее существовавших).
- После подключения анализаторов: без изменений (анализаторы не меняют код; ESLint/Detekt запускались read-only, база и боевая пара не тронуты — 8787 → 200 на протяжении раунда).
- Supervisor-matrix: исключена из общего прогона, запуск через `LAN_SUPERVISOR_TESTS=1 npm run test:isolation` (2 из 3 зелёные, полный цикл — отдельная задача).

## Ограничения этого аудита

- ktlint: часть правил конфликтуёт с текущим стилем (отступы) — считать их списком для автоформата, не ручных правок.
- ESLint `no-undef` в web — шум до дообогащения globals.
- Android Lint `NewerVersionAvailable`/`GradleDependency` (18 шт.) — по ограничению не трогаем версии.
- Detekt не анализирует мультиплатформенные `expect/actual` межпроектные связи — криптические расхождения ловятся компилятором.
