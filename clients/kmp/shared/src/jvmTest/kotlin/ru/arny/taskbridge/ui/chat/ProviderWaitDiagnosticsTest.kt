package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.ModelRef
import ru.arny.taskbridge.core.api.ProviderWait
import ru.arny.taskbridge.core.api.RuntimeInfo
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.client.chat.ChatSnapshot
import ru.arny.taskbridge.core.client.session.ChatSessionState
import ru.arny.taskbridge.core.client.session.LinkState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.Instant

/**
 * Отказ провайдера в диагностике.
 *
 * 2026-10-09 сессия «Подвести итог переноса Horror Engine» стояла полтора часа:
 * wormsoft ответил HTTP 429 «user reached the limit» с `retry-after-ms 5452000`,
 * Pi объявил повтор через 1 ч 31 мин — и в TaskBridge не появилось ни ошибки, ни
 * строки ожидания. Панель показывала RUNNING · streaming, а последней строкой
 * признавалась, что «источник задержки неизвестен», хотя Pi его назвал.
 */
class ProviderWaitDiagnosticsTest {
    private val start = 1_791_000_000_000L // 2026-10-03T04:00:00Z
    private val iso = { millis: Long -> Instant.fromEpochMilliseconds(millis).toString() }

    private val wait = ProviderWait(
        kind = "rate-limit",
        provider = "wormsoft",
        model = "wormsoft/anthropic/claude-opus-5.5",
        httpStatus = 429,
        reason = "user reached the limit",
        waitMs = 5_472_000,
        retryAt = iso(start + 5_472_000),
    )

    private fun state(waiting: ProviderWait?): ChatSessionState = ChatSessionState(
        taskId = "66a31a7aca85",
        task = Task(
            id = "66a31a7aca85",
            prompt = "Подвести итог переноса Horror Engine",
            status = "RUNNING",
            createdAt = iso(start),
            updatedAt = iso(start),
            model = ModelRef(provider = "wormsoft", id = "anthropic/claude-opus-5.5"),
            runtime = RuntimeInfo(state = "WORKING", activity = "waiting_model"),
            providerWait = waiting,
        ),
        chat = ChatSnapshot(),
        link = LinkState.Live,
        lastContactAt = iso(start),
        lastEventAt = iso(start),
        lastEventType = "PROVIDER_WAIT",
    )

    private fun render(waiting: ProviderWait? = wait, now: Long = start) =
        buildDiagnosticsDetails(state(waiting), info = null, externalMetrics = null, now = now) { "МОМЕНТ" }

    @Test
    fun theWaitNamesTheCauseAndTheRetryMoment() {
        val details = render()
        assertTrue(
            details.lineSequence().any {
                it == "Провайдер wormsoft/anthropic/claude-opus-5.5 не принял запрос: HTTP 429 «user reached the limit». " +
                    "Pi жив и повторит через 1 ч 31 мин (в МОМЕНТ) — сессия не зависла, ответа модели пока нет."
            },
            details,
        )
        // Источник задержки назван: признаваться в незнании рядом с ним нельзя.
        assertEquals(0, details.lineSequence().count { it.startsWith("Подтверждение агента") }, details)
    }

    @Test
    fun aPastRetryMomentIsNotInvented() {
        val details = render(now = start + 6 * 3_600_000L)
        assertTrue(
            details.lineSequence().any { it.startsWith("Провайдер wormsoft/anthropic/claude-opus-5.5 не принял запрос: HTTP 429") },
            details,
        )
        assertTrue(details.contains("сессия не зависла"), details)
        assertEquals(0, details.lineSequence().count { it.contains("через 1 ч 31 мин") }, details)
    }

    @Test
    fun withoutAWaitTheUnknownSourceLineStays() {
        val details = render(waiting = null)
        assertTrue(details.contains("источник задержки неизвестен"), details)
    }

    @Test
    fun thePhaseCountsDownFromTheRetryMoment() {
        assertEquals("Провайдер не принял запрос (HTTP 429) · повтор через 1 ч 31 мин · подробнее", providerWaitPhase(wait, start))
        // Момент повтора прошёл: остаток не выдумывается, но и отказ не исчезает.
        assertEquals("Провайдер не принял запрос (HTTP 429) · подробнее", providerWaitPhase(wait, start + 6 * 3_600_000L))
    }

    @Test
    fun theCauseFallsBackToTheProvidersOwnWords() {
        val noHttp = wait.copy(httpStatus = null, reason = "Connection error")
        assertEquals("Провайдер не принял запрос (Connection error) · подробнее", providerWaitPhase(noHttp, start + 6 * 3_600_000L))
        // Момента повтора нет — и остаток не выдумывается.
        assertEquals("Провайдер не принял запрос (нет ответа) · подробнее", providerWaitPhase(noHttp.copy(reason = null, retryAt = null), start))
    }

    @Test
    fun aCauseThatOnlyRepeatsTheStatusIsNotQuoted() {
        // 2026-10-12: провайдер ответил HTTP 507 без тела, и причина пришла как сам
        // код — строка читалась «… не принял запрос: HTTP 507 «HTTP 507»».
        val noBody = wait.copy(httpStatus = 507, reason = "HTTP 507")
        assertTrue(
            render(waiting = noBody).lineSequence().any {
                it.startsWith("Провайдер wormsoft/anthropic/claude-opus-5.5 не принял запрос: HTTP 507. Pi жив и повторит")
            },
            render(waiting = noBody),
        )
        // Без кода причина и есть код: цитата повторила бы её дважды.
        val noHttp = wait.copy(httpStatus = null, reason = "fetch failed")
        assertTrue(
            render(waiting = noHttp).lineSequence().any {
                it.contains("не принял запрос: fetch failed. Pi жив") && !it.contains("«fetch failed»")
            },
            render(waiting = noHttp),
        )
    }
}
