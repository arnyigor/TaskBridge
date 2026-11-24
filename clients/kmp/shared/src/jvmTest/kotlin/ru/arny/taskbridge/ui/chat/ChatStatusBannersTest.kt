package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import ru.arny.taskbridge.core.api.ApiError
import ru.arny.taskbridge.core.api.SessionStorage
import ru.arny.taskbridge.core.client.session.LinkState
import ru.arny.taskbridge.core.client.session.describe

/**
 * Полоса баннеров: состав, порядок и формулировки. Раньше порядок жил в теле
 * экрана и не проверялся ничем; теперь это контракт чистой функции.
 */
class ChatStatusBannersTest {

    @Test
    fun `nothing to report means no banners`() {
        assertEquals(
            emptyList<StatusBanner>(),
            statusBanners(online = true, storeMismatch = false, link = LinkState.Live, storage = null),
        )
    }

    @Test
    fun `order is fixed - offline, foreign instance, link, storage`() {
        val banners = statusBanners(
            online = false,
            storeMismatch = true,
            link = LinkState.Reconnecting(attempt = 1, inMillis = 3000, reason = "refused"),
            storage = SessionStorage(bytes = 2_000_000_000, warn = true),
        )
        assertEquals(4, banners.size)
        assertTrue(banners[0].text.startsWith("Устройство offline"))
        assertTrue(banners[1].text.startsWith("Подключён другой экземпляр"))
        assertTrue(banners[2].text.startsWith("Нет связи"))
        assertTrue(banners[3].text.startsWith("Сессия занимает"))
        assertEquals(BannerTone.FAILED, banners[1].tone, "чужой экземпляр — status.failed, как в исходном вызове")
    }

    @Test
    fun `sub-second reconnect never says zero seconds`() {
        val banner = linkBanner(LinkState.Reconnecting(attempt = 1, inMillis = 400, reason = "x"))!!
        assertTrue(banner.text.contains("через 1 с"), banner.text)
        assertTrue(banner.retryable)
        assertEquals(BannerTone.WAITING, banner.tone)
    }

    @Test
    fun `degraded is a different sentence and keeps the retry action`() {
        val banner = linkBanner(LinkState.Degraded(attempt = 2, inMillis = 2000, reason = "stream closed"))!!
        assertTrue(banner.text.contains("поток событий оборван"), banner.text)
        assertTrue(banner.retryable)
        assertEquals(BannerGlyph.ALERT, banner.glyph)
    }

    @Test
    fun `failed link has no retry - NotFound speaks its own words, others use describe`() {
        val gone = linkBanner(LinkState.Failed(ApiError.NotFound("нет")))!!
        assertEquals("Сессия удалена на компьютере.", gone.text)
        assertFalse(gone.retryable)
        assertEquals(BannerTone.ERROR, gone.tone)

        val other = ApiError.Unreachable("обрыв")
        assertEquals(describe(other), linkBanner(LinkState.Failed(other))!!.text)
    }

    @Test
    fun `live and connecting show no link banner`() {
        assertNull(linkBanner(LinkState.Live))
        assertNull(linkBanner(LinkState.Connecting))
    }
}
