package ru.arny.taskbridge.ui.chat

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import ru.arny.taskbridge.core.api.ApiError
import ru.arny.taskbridge.core.api.SessionStorage
import ru.arny.taskbridge.core.client.session.LinkState
import ru.arny.taskbridge.core.client.session.describe
import ru.arny.taskbridge.ui.common.Banner
import ru.arny.taskbridge.ui.common.formatBytes
import ru.arny.taskbridge.ui.theme.AppIcons
import ru.arny.taskbridge.ui.theme.LocalStatusColors

/**
 * Полоса состояния над лентой чата.
 *
 * «Что показать» решает чистая [statusBanners] — порядок баннеров зафиксирован
 * в одном месте и проверяется тестом, а не порядком строк в теле экрана.
 * «Как показать» — [ChatStatusBanners]: данные и один колбэк, без знания о сессии.
 * Новый баннер добавляется строкой в модель, рендер не меняется.
 */

/** Семантический тон баннера; в цвет превращается только в композабле. */
internal enum class BannerTone { WAITING, FAILED, ERROR }

/** Семантическая иконка; в ImageVector превращается только в композабле. */
internal enum class BannerGlyph { OFFLINE, ALERT, LAYERS }

internal data class StatusBanner(
    val text: String,
    val glyph: BannerGlyph,
    val tone: BannerTone,
    /** Кнопка «Сейчас»: немедленное переподключение потока. */
    val retryable: Boolean = false,
)

/** Баннер связи; null — связь в порядке, показывать нечего. */
internal fun linkBanner(link: LinkState): StatusBanner? = when (link) {
    is LinkState.Reconnecting -> StatusBanner(
        text = "Нет связи с компьютером — переподключение через ${(link.inMillis / 1000).coerceAtLeast(1)} с",
        glyph = BannerGlyph.OFFLINE,
        tone = BannerTone.WAITING,
        retryable = true,
    )
    // Сервер отвечает, поток оборван: это другая поломка, чем «нет связи», и
    // лечится ожиданием, а не проверкой сети на компьютере (план 4.2).
    is LinkState.Degraded -> StatusBanner(
        text = "Компьютер отвечает, но поток событий оборван — переподключаюсь через " +
            "${(link.inMillis / 1000).coerceAtLeast(1)} с",
        glyph = BannerGlyph.ALERT,
        tone = BannerTone.WAITING,
        retryable = true,
    )
    is LinkState.Failed -> StatusBanner(
        text = when (link.error) {
            is ApiError.NotFound -> "Сессия удалена на компьютере."
            else -> describe(link.error)
        },
        glyph = BannerGlyph.ALERT,
        tone = BannerTone.ERROR,
    )
    LinkState.Connecting, LinkState.Live -> null
}

/**
 * Предупреждение о размере сессии на диске компьютера; null — предупреждать не о чем.
 *
 * Порог считает сервер (`storage.warnSessionMb`), клиент договаривает следствие:
 * место занимают журнал кадров (вывод инструментов) и вложения сессии, освободить
 * его можно удалением сессии. Автоматически ничего не удаляется и не ограничивается.
 */
internal fun sessionStorageWarning(storage: SessionStorage?): String? {
    if (storage?.warn != true) return null
    val atLeast = if (storage.partial) "не менее " else ""
    return "Сессия занимает $atLeast${formatBytes(storage.bytes)} на диске компьютера — это её журнал и вложения. " +
        "Освободить место можно удалением сессии"
}

/** Что показать над лентой, в фиксированном порядке: offline → чужой экземпляр → связь → размер. */
internal fun statusBanners(
    online: Boolean,
    storeMismatch: Boolean,
    link: LinkState,
    storage: SessionStorage?,
): List<StatusBanner> = buildList {
    if (!online) add(
        StatusBanner(
            text = "Устройство offline — показана сохранённая история, команды останутся в outbox",
            glyph = BannerGlyph.ALERT,
            tone = BannerTone.WAITING,
        ),
    )
    if (storeMismatch) add(
        StatusBanner(
            text = "Подключён другой экземпляр TaskBridge — эта история не с этого компьютера",
            glyph = BannerGlyph.OFFLINE,
            tone = BannerTone.FAILED,
        ),
    )
    linkBanner(link)?.let(::add)
    sessionStorageWarning(storage)?.let { add(StatusBanner(it, BannerGlyph.LAYERS, BannerTone.WAITING)) }
}

@Composable
internal fun ChatStatusBanners(banners: List<StatusBanner>, onRetryLink: () -> Unit) {
    val status = LocalStatusColors.current
    for (banner in banners) {
        Banner(
            text = banner.text,
            icon = when (banner.glyph) {
                BannerGlyph.OFFLINE -> AppIcons.Offline
                BannerGlyph.ALERT -> AppIcons.Alert
                BannerGlyph.LAYERS -> AppIcons.Layers
            },
            // Тоны сохранены ровно как в исходных вызовах: mismatch использовал
            // status.failed, а Failed-связь — colorScheme.error. Это разные цвета.
            color = when (banner.tone) {
                BannerTone.WAITING -> status.waiting
                BannerTone.FAILED -> status.failed
                BannerTone.ERROR -> MaterialTheme.colorScheme.error
            },
            action = if (banner.retryable) "Сейчас" else null,
            onAction = if (banner.retryable) onRetryLink else null,
        )
    }
}
