package ru.arny.taskbridge.core.client

import ru.arny.taskbridge.core.api.ApiError
import ru.arny.taskbridge.core.client.session.HEALTH_PROBE_TIMEOUT_MS
import ru.arny.taskbridge.core.client.session.LinkState
import ru.arny.taskbridge.core.client.session.linkAfterStreamFailure
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * Двухуровневый health (план 4.2): оборванный поток при живом сервере — это
 * DEGRADED («компьютер отвечает, поток оборван»), а не «нет связи». Разница
 * важна оператору: первое лечится ожиданием, второе — проверкой сети.
 */
class LinkHealthTest {
    private val refused = ApiError.Unreachable("Connection refused")

    @Test
    fun `a live server with a dead stream is degraded, not offline`() {
        val state = linkAfterStreamFailure(refused, serverAlive = true, attempt = 2, inMillis = 2000, reason = "stream closed")
        assertIs<LinkState.Degraded>(state)
        assertEquals(2, state.attempt)
        assertEquals(2000L, state.inMillis)
    }

    @Test
    fun `no answer to health is plain offline`() {
        val state = linkAfterStreamFailure(refused, serverAlive = false, attempt = 1, inMillis = 1500, reason = "Connection refused")
        assertIs<LinkState.Reconnecting>(state)
    }

    @Test
    fun `an unknown probe result does not claim the server is alive`() {
        assertIs<LinkState.Reconnecting>(linkAfterStreamFailure(refused, serverAlive = null, attempt = 1, inMillis = 1500, reason = "x"))
    }

    @Test
    fun `a permanent error stays failed and is never retried as degraded`() {
        assertIs<LinkState.Failed>(linkAfterStreamFailure(ApiError.NotFound("нет"), serverAlive = true, attempt = 1, inMillis = 1500, reason = "x"))
    }

    @Test
    fun `the health probe has a short budget so it cannot slow reconnection`() {
        assertTrue(HEALTH_PROBE_TIMEOUT_MS in 500..5_000, "проба на пути переподключения: ${HEALTH_PROBE_TIMEOUT_MS} мс")
    }
}
