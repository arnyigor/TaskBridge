package ru.arny.taskbridge.ui.sessions

/**
 * Что обещать в диалоге кнопки «Перезапустить сервер».
 *
 * Кнопка одна, а положений сервера три: живой (перезапуск), потушенный там, где
 * приложение умеет поднять его само (desktop с найденным каталогом TaskBridge), и
 * потушенный там, где поднимать нечем — на телефоне лаунчера нет вовсе, а на
 * desktop он бесполезен без каталога.
 *
 * 2026-10-12 сервер был убит, и кнопка была нажата с телефона: диалог обещал
 * запуск («Запустить»), а объяснение советовало указать каталог TaskBridge в
 * настройках — на телефоне такого пункта нет. Правда приходила только подсказкой
 * после нажатия, и выглядело это как «кнопка не работает, помогает только батник».
 * Поэтому [canStart] решает и текст, и набор кнопок: там, где запустить нечем,
 * диалог не предлагает запуск, а называет единственное, что помогает.
 */
internal data class ServerStartOffer(
    val title: String,
    val text: String,
    /** Кнопка подтверждения запуска: false — остаётся только «Понятно». */
    val canStart: Boolean,
    val confirmLabel: String,
)

internal fun serverStartOffer(online: Boolean, canStartLocalServer: Boolean, phone: Boolean): ServerStartOffer = when {
    online -> ServerStartOffer(
        title = "Перезапустить сервер TaskBridge?",
        text = "Активные сессии будут прерваны. Приложение переподключится само через несколько секунд.",
        canStart = true,
        confirmLabel = "Перезапустить",
    )
    canStartLocalServer -> ServerStartOffer(
        title = "Запустить сервер TaskBridge?",
        text = "Сервер сейчас недоступен. Он будет запущен на этом компьютере скрытым процессом — без консольного окна.",
        canStart = true,
        confirmLabel = "Запустить",
    )
    phone -> ServerStartOffer(
        title = "Сервер на компьютере не запущен",
        text = "С телефона его не запустить: сервер живёт на компьютере. Запустите TaskBridge на ПК " +
            "(ярлык или start.cmd) — телефон подключится сам.",
        canStart = false,
        confirmLabel = "Понятно",
    )
    // Desktop без найденного каталога: запуск возможен, но сначала настройка —
    // поэтому обещаем не скрытый процесс, а то, что действительно нужно сделать.
    else -> ServerStartOffer(
        title = "Запустить сервер TaskBridge?",
        text = "Сервер сейчас недоступен. Каталог TaskBridge (scripts/start-lan.mjs) не найден — " +
            "укажите его в настройках → «Каталог TaskBridge».",
        canStart = true,
        confirmLabel = "Запустить",
    )
}
