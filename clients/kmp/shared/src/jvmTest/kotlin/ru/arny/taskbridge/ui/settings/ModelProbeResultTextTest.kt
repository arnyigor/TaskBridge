package ru.arny.taskbridge.ui.settings

import ru.arny.taskbridge.core.api.ModelProbeResult
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ModelProbeResultTextTest {
    @Test
    fun `success states the measured latency and token cost`() {
        assertEquals(
            "321 мс · 1 токен",
            modelProbeResultText(ModelProbeResult(ok = true, ms = 321, tokensUsed = 1)),
        )
        assertEquals(
            "40 мс · без токенов",
            modelProbeResultText(ModelProbeResult(ok = true, ms = 40, tokensUsed = 0)),
        )
    }

    @Test
    fun `known failures are actionable words`() {
        assertEquals(
            "Повтор через 5 с",
            modelProbeResultText(ModelProbeResult(code = "COOLDOWN", retryInMs = 4100)),
        )
        assertEquals(
            "Провайдер отклонил ключ (401)",
            modelProbeResultText(ModelProbeResult(code = "AUTH")),
        )
        assertTrue(
            modelProbeResultText(ModelProbeResult(code = "PROVIDER_ERROR", message = "model loading"))
                .contains("model loading"),
        )
        assertEquals(
            "Провайдер не прислал ни одного токена",
            modelProbeResultText(ModelProbeResult(code = "NO_STREAM")),
        )
        assertEquals(
            "HTTP 503: maintenance",
            modelProbeResultText(ModelProbeResult(code = "HTTP_ERROR", httpStatus = 503, message = "maintenance")),
        )
    }
}
