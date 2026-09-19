# Проект: habrrss | Срез от 2026-09-17 17:58

# HabrRSS: пейджинг ленты всех фидов (коммит e841d01, ветка master, БЕЗ тега)

## Что сделано (после v1.0.8)
Лента любого фида больше не грузит весь архив в память: страницы по 200 из БД (SQL), как для «Все загруженные».
- `FeedDao.getAllCachedPaged/countAllCachedPaged(feedId: String?, ...)` — NULL = вся база; SQL `(:feedId IS NULL OR feedId = :feedId)`. ORDER BY получил tiebreaker `, id ASC` (иначе границы страниц могли терять строки).
- `TechReaderRepository.observeFeedPage(feedId, limit, offset, hub/tag/query/hideRead)` + `countFeedPage(...)`; удалены мёртвые `observeFeed`/`countFeed` и константа FEED_LIST_LIMIT. `FEED_PAGE_SIZE = 200` (в VM и в репозитории — синхронизировать!).
- `FeedViewModel`: `feedPageOffset/feedPageHasMore`; `observeFeedPageFlow` для любого фида; `loadMoreItems` = сначала локальная страница (`loadNextFeedPage`), затем сетевой импорт; курсор двигается на `items.size` (не фикс. шаг) — иначе при импорте/дедупе пропуск строк. `canLoadMore = feedPageHasMore || remoteHasMore` — владелец только flow (не refresh/selectFeed/openHubFeed/loadAllPages).
- `openHubFeed` → `refreshFeed(force = false)` (быстрое переключение хабов, вернул потерянный ранее фикс).
- Поиск: SQL предфильтр по ПЕРВОМУ слову (`LIKE`), точное совпадение всех слов — in-memory (`matchesSearchTerm`); счётчик «Показано N из M» скрывается для многословных запросов.
- In-memory фильтры (unread/tag/hub) пропускаются для SQL-страничных фидов; для закладок — полный проход.
- В MemoryFeedDao/FileBacked(jvm+android): `stableNewestFirst()` (tiebreaker по id) + `matching(feedId, ...)`.

## Найденные ревьюером баги (исправлены)
1. HIGH: после сетевого импорта offset прыгал на +200 → пропуск строк. Теперь `feedPageOffset = state.items.size`.
2. MEDIUM: `loadAllPages` finally писал `canLoadMore = remoteHasMore` → после полного импорта пагинация отключалась. Теперь `|| feedPageHasMore`.
3. MEDIUM: нестабильная сортировка → пропуск на границе страниц. Добавлен tiebreaker `id`.

## Проверено
Локально: `:composeApp:jvmTest` и `:composeApp:assembleRelease` — SUCCESS. Detekt: 128 findings (было 129) — общий долг проекта в незатронутых файлах (ArticleUtils/RelativeDate/HabrRssSource), не регресс.
На устройстве (до отзыва телефона): пейджинг хаба 200→1200 при прокрутке; счётчик «Показано 200 из 22022»; поиск по всей базе («191 из 810», многословный «kotlin compose» → 15); импорт 220 страниц без краша, Java Heap 10–31 МБ (было 263 → OOM).

## Осталось дотестировать на телефоне (когда вернётся)
- догрузка результатов поиска скроллом (счётчик должен расти),
- импорт всех страниц после фиксов курсора (не пропускает ли строки),
- переключение хабов/тегов, статья/закладки.
После проверки — поставить тег v1.0.9 и релиз (versionCode 10, versionName 1.0.9 уже в build.gradle).