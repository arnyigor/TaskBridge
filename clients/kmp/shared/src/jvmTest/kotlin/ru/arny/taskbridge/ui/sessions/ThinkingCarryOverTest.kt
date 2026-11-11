package ru.arny.taskbridge.ui.sessions

import ru.arny.taskbridge.core.api.ModelRef
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Перенос уровня размышлений при смене модели в форме новой сессии.
 *
 * «off» — единственный уровень модели без размышлений. Если переносить его на
 * рассуждающую модель, выбор залипает на «None», хотя уровни у неё есть.
 */
class ThinkingCarryOverTest {

    private val noThinking = ModelRef(provider = "plain", id = "m", reasoning = false, thinkingLevels = listOf("off"))
    private val thinking = ModelRef(provider = "strata", id = "t", reasoning = true, thinkingLevels = listOf("off", "low", "medium", "high"))

    @Test
    fun offDoesNotStickWhenTheNewModelCanThink() {
        val previous = thinkingChoices(noThinking, null)
        val carried = if (previous.size <= 1 && "off" in previous) null else "off"
        assertEquals("medium", clampThinkingLevel(carried ?: "medium", thinkingChoices(thinking, null)))
    }

    @Test
    fun anExplicitChoiceSurvivesAModelChange() {
        // «high» — осознанный выбор человека, его переносим, если модель его принимает.
        assertEquals("high", clampThinkingLevel("high", thinkingChoices(thinking, null)))
    }

    @Test
    fun anUnsupportedLevelIsClampedToTheNearestOne() {
        val narrow = thinking.copy(thinkingLevels = listOf("off", "low"))
        assertEquals("low", clampThinkingLevel("high", thinkingChoices(narrow, null)))
    }
}
