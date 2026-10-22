package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.LocalModelEntry
import ru.arny.taskbridge.core.api.LocalModelMetrics
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * STAB-STATUS-01: какой строке живого движка верить и когда показывать «Модель
 * читает промпт».
 *
 * Наблюдение 2026-10-22 (Desktop, настоящая Strata): движок читает промпт
 * (73 728 / 185 025 токенов, PP ≈ 2 336), а TaskBridge пишет «Сообщение передано ·
 * ожидается ответ агента». Причина — сопоставление строки по точному равенству:
 * Pi называет сессию `strata` / `qwen3.8-flash-next-iq3_s`, а конфиг TaskBridge —
 * `strata-iq3s` / `qwen3.8-flash-next-iq3-s`. Ни provider, ни id не совпадали,
 * телеметрия не находилась.
 */
class PromptReadingPhaseTest {

    // Ровно эти две формы взяты у живой установки: снимок задачи и /api/info.
    private val sessionProvider = "strata"
    private val sessionModelId = "qwen3.8-flash-next-iq3_s"

    private fun strataRow(
        id: String = "qwen3.8-flash-next-iq3-s",
        provider: String? = "strata-iq3s",
        phase: String? = "reading the prompt",
        promptRead: Long? = 73_728,
        promptTotal: Long? = 185_025,
    ) = LocalModelEntry(
        id = id,
        provider = provider,
        external = true,
        status = "loaded",
        metrics = LocalModelMetrics(
            available = true,
            source = "strata",
            phase = phase,
            promptRead = promptRead,
            promptTotal = promptTotal,
            pp = 2_336.0,
        ),
    )

    @Test
    fun piAndConfigNamesFindTheSameEngineRow() {
        // Точного совпадения нет ни по провайдеру, ни по id — виноват регистр имён.
        val rows = listOf(strataRow())
        val found = externalModelRow(rows, sessionProvider, sessionModelId)
        assertEquals("strata-iq3s", found?.provider)
        assertEquals("reading the prompt", found?.metrics?.phase)
        assertEquals(73_728, found?.metrics?.promptRead)
    }

    @Test
    fun anExactMatchWinsOverAFuzzyOne() {
        val exact = strataRow(id = "qwen3.8-flash-next-iq3_s", provider = "strata")
        val other = strataRow(id = "qwen3.8-flash-next-iq3s", provider = "strata-iq3s")
        assertEquals(exact, externalModelRow(listOf(other, exact), sessionProvider, sessionModelId))
    }

    @Test
    fun severalRowsWithTheSameModelAreRefusedInsteadOfGuessed() {
        // Две модели того же сервера: приписать чужой прогресс чтения нельзя.
        val rows = listOf(strataRow(provider = "strata-a"), strataRow(provider = "strata-b"))
        assertNull(externalModelRow(rows, sessionProvider, sessionModelId))
    }

    @Test
    fun theProviderAloneIsEnoughWhenItIsTheOnlyRow() {
        val rows = listOf(strataRow(id = "another-model"))
        assertEquals("another-model", externalModelRow(rows, sessionProvider, sessionModelId)?.id
            ?: externalModelRow(rows, sessionProvider, null)?.id)
        assertEquals("another-model", externalModelRow(rows, sessionProvider, null)?.id)
    }

    @Test
    fun noLocalEnginesMeansNoRow() {
        assertNull(externalModelRow(emptyList(), sessionProvider, sessionModelId))
    }

    @Test
    fun theThirdTurnShowsReadingEvenThoughTheSecondOneAnswered() {
        // Последовательные ходы: ответ предыдущего хода в истории — норма, и он не
        // должен скрывать prefill текущего. answerSilent говорит про ТЕКУЩИЙ ход.
        val found = externalModelRow(listOf(strataRow()), sessionProvider, sessionModelId)
        val readingPrompt = found?.metrics?.phase?.contains("read", ignoreCase = true) == true
        assertTrue(readingPrompt)
        assertTrue(readsPromptNow(readingPrompt, found?.metrics?.pp, answerSilent = true))
        // Пошли токены/текст текущего хода — чтение промпта больше не показывается.
        assertFalse(readsPromptNow(readingPrompt, found?.metrics?.pp, answerSilent = false))
    }

    @Test
    fun stalePhaseAloneDoesNotMeanReadingWhenTheTurnAlreadyProducedText() {
        // Фаза движка ещё «reading…», но текущий ответ уже не пуст: подпись не врёт.
        assertFalse(readsPromptNow(readingPrompt = true, livePp = null, answerSilent = false))
    }

    @Test
    fun aSilentTurnWithoutLiveSignalsStaysWithoutReadingPrompt() {
        // Ни фазы, ни живого PP: показывать нечего, статус остаётся нейтральным.
        assertFalse(readsPromptNow(readingPrompt = false, livePp = null, answerSilent = true))
    }

    @Test
    fun readyIsNotReading() {
        // `ready` содержит `read`: по подстроке готовый сервер выглядел читающим.
        assertFalse(engineReadingPrompt("ready"))
        assertFalse(engineReadingPrompt("READY"))
        assertFalse(engineReadingPrompt("idle"))
        assertFalse(engineReadingPrompt("generating"))
        assertFalse(engineReadingPrompt("loading model"))
        assertFalse(engineReadingPrompt("model loading"))
        assertFalse(engineReadingPrompt(null))
        assertTrue(engineReadingPrompt("reading the prompt"))
        assertTrue(engineReadingPrompt("Reading prompt"))
        assertTrue(engineReadingPrompt("prefill: reading (40%)"))
    }

    @Test
    fun twoServersWithTheSamePrefixAreNotGuessed() {
        // STATUS-13: сессия на `strata`, а живых строк две — приписать чужой
        // процент чтения нельзя. Нейтральное состояние лучше чужого прогресса.
        val rows = listOf(
            strataRow(id = "qwen3.8-flash-next-iq3-s", provider = "strata-iq3s"),
            strataRow(id = "qwen3.8-flash-next-iq3-s-q4", provider = "strata-q4", promptRead = 10, promptTotal = 90),
        )
        assertNull(externalModelRow(rows, "strata", "unknown-model"))
    }

    @Test
    fun twoSessionsGetTheirOwnEngineRow() {
        // STATUS-15: переключение между сессиями не переносит метрики соседней модели.
        val rows = listOf(
            strataRow(id = "qwen3.8-flash-next-iq3-s", provider = "strata-iq3s", promptRead = 73_728),
            strataRow(id = "qwen3.8-big-q4", provider = "strata-q4", promptRead = 5_120),
        )
        val first = externalModelRow(rows, "strata", "qwen3.8-flash-next-iq3_s")
        val second = externalModelRow(rows, "strata-q4", "qwen3.8-big-q4")
        assertEquals(73_728, first?.metrics?.promptRead)
        assertEquals(5_120, second?.metrics?.promptRead)
        assertNull(externalModelRow(rows, "llama.cpp", "qwen-27b-q3"), "чужая сессия не получает строку")
    }

    @Test
    fun theSameModelIdInTwoRowsNeedsTheProvider() {
        val rows = listOf(
            strataRow(id = "qwen3.8-flash-next-iq3-s", provider = "strata-iq3s"),
            strataRow(id = "qwen3.8-flash-next-iq3-s", provider = "strata-q4"),
        )
        assertNull(externalModelRow(rows, "strata", "qwen3.8-flash-next-iq3s"))
        assertEquals("strata-q4", externalModelRow(rows, "strata-q4", "qwen3.8-flash-next-iq3s")?.provider)
    }

    @Test
    fun theEngineInfoIsNotPolledInTheBackground() {
        // STATUS-16: в фоне и после хода — ни одного лишнего /api/info.
        assertTrue(shouldRefreshEngineInfo(activeTurn = true, inForeground = true))
        assertFalse(shouldRefreshEngineInfo(activeTurn = true, inForeground = false))
        assertFalse(shouldRefreshEngineInfo(activeTurn = false, inForeground = true))
    }
}
