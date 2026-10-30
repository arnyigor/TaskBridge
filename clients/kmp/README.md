# TaskBridge — Android и Windows-клиенты

**Версия 1.3.0.** Compose Multiplatform-клиенты для сервера TaskBridge: сессии, потоковый чат, очередь, STOP, подтверждения инструментов, история, выбор модели и уведомления.

Клиент подключается к HTTP/SSE API сервера. Установка Pi, авторизация провайдера, резервное копирование и обновление сервера описаны в [корневом README](../../README.md). Контракт — [docs/api-contract.md](../../docs/api-contract.md).

## Поддержка

| Платформа | Подтверждённая конфигурация |
| --- | --- |
| Windows | x64, portable с вложенным Java runtime |
| Android | API 24+, compile/target SDK 37; debug APK для локальной установки |
| Web | Отдельный интерфейс из каталога `web/`, обслуживается сервером |

Другие desktop-платформы и iOS не входят в подтверждённую матрицу выпуска. Для Android release необходим постоянный ключ подписи; debug APK не является артефактом для магазина.

## Структура

```text
core/api/       DTO, REST/SSE, типизированные ошибки, разбор протокола
core/client/    ChatReducer, ChatSession, outbox, настройки и состояние сессий
shared/         общий Compose UI и Android/JVM-адаптеры
androidApp/     Activity, Android lifecycle, сервис уведомлений
desktopApp/     окно, трей, single instance, portable updater
```

`core/` — отдельная Gradle-сборка без Android-плагина. Её common-исходники также компилируются в `shared/`; копии клиентской логики не расходятся.

## Сборка в Windows

Нужны JDK и Android SDK; используйте приложенный Gradle Wrapper. Android SDK укажите в локальном `local.properties`:

```properties
sdk.dir=C:/Users/USERNAME/AppData/Local/Android/Sdk
```

Из каталога `clients/kmp`:

```powershell
./gradlew.bat :shared:jvmTest --console=plain
./gradlew.bat :androidApp:assembleDebug --console=plain
./gradlew.bat :desktopApp:portable --console=plain
```

Результаты:

- Android: `androidApp/build/outputs/apk/debug/androidApp-debug.apk`.
- Windows: `dist/.staging/TaskBridge/`, включая `TaskBridge.exe`, `app/` и `runtime/`.

Работающий portable обновляется через трей **«Установить обновление и перезапустить»**. Перезапись файлов запущенного приложения приводит к блокировкам Windows. Если клиент закрыт, установка подготовленного пакета доступна через `:desktopApp:installPortable`.

Клиентский Java runtime входит в portable. Для запуска сервера на этом компьютере по-прежнему нужны Node.js и Pi. Задача `:desktopApp:standalonePortable` добавляет серверные файлы; внешние Node.js/Pi она не заменяет.

## Тесты

```powershell
Push-Location core
../gradlew.bat :api:jvmTest :client:jvmTest --console=plain
Pop-Location
./gradlew.bat :shared:jvmTest :desktopApp:test --console=plain
```

Интеграционные тесты запускают изолированный сервер на fake Pi и требуют `node` в `PATH`. Обновление протокольных фикстур выполняется из корня репозитория:

```powershell
node scripts/export-api-fixtures.mjs
node scripts/export-chat-fixtures.mjs
```

`:shared:realProviderUiProbe` — отдельная ручная проверка реального OpenRouter. Она требует `OPENROUTER_API_KEY` и установленный Pi, проверяет нулевую цену выбранной модели и не запускается обычным offline CI.

## Подтверждённое поведение и ограничения

- JVM-тесты API, client и shared Compose проходят; debug APK и Windows portable собираются. Подробные результаты — [отчёт стабилизации](../../docs/stabilization.md).
- История, черновики, outbox и reconnect покрыты регрессиями. Команда, принятая сервером, и ответ модели имеют разные состояния.
- KMP ограничивает открытие SSE, ожидание данных и чтение тела ошибки; общий автоматический предел генерации не задан.
- Reasoning отображается ограниченным хвостом, копируется полный исходный текст. Проверены тяжёлый смешанный чат и ввод во время streaming.
- Нативные Windows frame/input/retained-heap замеры и содержимое системного Android clipboard ещё требуют отдельной приёмки; callback копирования проверен через Compose.
- Самоподписанный HTTPS и фоновые уведомления зависят от доверия сертификату и ограничений ОС. Проверяйте подключение и уведомления на целевом устройстве.

Номер выпуска задаётся в `gradle.properties` (`taskbridgeVersion`), desktop-ресурсе `taskbridge-version.txt` и Android `versionName`; Android `versionCode` повышается отдельно. Версия сервера находится в корневом `package.json`.
