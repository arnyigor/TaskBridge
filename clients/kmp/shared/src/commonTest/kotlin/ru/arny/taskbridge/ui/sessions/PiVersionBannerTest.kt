package ru.arny.taskbridge.ui.sessions

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import ru.arny.taskbridge.core.api.PiInfo

class PiVersionBannerTest {
    /** No /api/info yet: nothing to warn about. */
    @Test
    fun anUnknownInfoObjectShowsNoBanner() {
        assertNull(piVersionBanner(null))
    }

    /**
     * The reported bug: the server answered `/api/info` with `version: null`
     * (the `pi --version` probe timed out while the machine was building) and
     * `supported: false`, and the phone drew "Pi не найден: версия не
     * проверялась с TaskBridge".
     */
    @Test
    fun anUnknownVersionShowsNoBanner() {
        val pi = PiInfo(version = null, supported = false, supportedRange = ">=0.85.0 <0.89.0", error = "pi --version did not answer in 10000 ms")
        assertNull(piVersionBanner(pi))
    }

    @Test
    fun aKnownSupportedVersionShowsNoBanner() {
        val pi = PiInfo(version = "0.87.1", supported = true, supportedRange = ">=0.85.0 <0.89.0")
        assertNull(piVersionBanner(pi))
    }

    @Test
    fun aKnownUnsupportedVersionShowsTheBanner() {
        val pi = PiInfo(version = "0.90.0", supported = false, supportedRange = ">=0.85.0 <0.89.0")
        assertEquals("Pi 0.90.0: версия не проверялась с TaskBridge (>=0.85.0 <0.89.0)", piVersionBanner(pi))
    }
}
