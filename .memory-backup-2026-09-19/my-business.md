# Проект: my-business | Срез от 2026-09-16 18:18

## PSB «Мой Бизнес»
### Локальная сборка (Windows, ArnyPC) — невозможна без VPN
- Проверено: gradlew падает на шаге 0 — wrapper качает Gradle 7.4 с nexus-external.psbnk.msk.ru → UnknownHostException.
- Оба nexus ПСБ (nexus-external.psbnk.msk.ru, nexus-internal.headoffice.psbank.local) недоступны (curl 000). services.gradle.org и mavenCentral — доступны (200).
- В ~/.gradle/caches нет ru.psbank* артефактов; AGP 7.1.0 / Kotlin 1.6.10 тоже не кэшированы (есть другие версии).
- Зависимости только из внутреннего nexus: buildscript-плагины ru.psbank.msb:psb-openapi-generator:1.1.7, ru.psbank.checkmarx-sources-plugin, ru.psbank.msb.affectedmodulescheckplugin, ru.psbank.notifier:express-notifier:2.0.0, digitalruble plugin + 26 внутренних AAR (uikitv2×6, uikitv2-groupie, uicomponents, fieldum×4, mdk×3, push_receiver, testit, qa-service, mocks, formatters, utility-android, wrapper-crypto-pro, officesandatms, kaspresso-detekt-rules).
- Заменяемо локально: distributionUrl → services.gradle.org (публичный URL уже закомментирован в gradle-wrapper.properties); google()/mavenCentral() для AGP/Kotlin/detekt/ksp. НЕ заменяемо: внутренние ru.psbank AAR и плагины (нет публичных зеркал).
- Источник uikitv2 лежит локально: ..\uikitv2 (6 модулей) — возможен composite build, но остальные 20+ внутренних AAR без исходников.
- local.properties создан: sdk.dir=G:\Android\Sdk (gitignored). SDK: G:\Android\Sdk (platforms до android-37, build-tools до 37), JDK 17 (ms-17.0.17).
- Вывод: полная сборка только на Linux в офисе; локально — максимум targeted kotlinc-верификация изменённых consent-файлов по стабам.