package ru.arny.taskbridge.ui.sessions

import ru.arny.taskbridge.core.api.ModelRef
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Уровень размышлений сопоставляется с картой КОНКРЕТНОЙ модели, а не с общим
 * списком каталога: у локальных моделей (Strata) набор другой, «minimal» и «max»
 * в их карте равны null, а «High» уходит в движок как xhigh. Данные ниже —
 * verbatim из models.json для strata-iq3 и из ответа сервера для обычной модели.
 */
class ThinkingLevelsTest {
    private val strata = ModelRef(
        provider = "strata-iq3",
        id = "qwen3.8-flash-next-iq3-xxs",
        reasoning = true,
        local = true,
        thinkingLevels = listOf("off", "low", "medium", "high", "xhigh"),
        thinkingMap = mapOf("off" to "none", "high" to "xhigh"),
    )
    private val plain = ModelRef(provider = "deepseek", id = "deepseek-flash", reasoning = true, thinkingLevels = listOf("off", "minimal", "low", "medium", "high"))
    private val catalogLevels = listOf("off", "minimal", "low", "medium", "high", "xhigh", "max")

    @Test
    fun pickerUsesTheModelMapNotTheCatalogueList() {
        assertEquals(listOf("off", "low", "medium", "high", "xhigh"), thinkingChoices(strata, catalogLevels))
        assertEquals(listOf("off", "minimal", "low", "medium", "high"), thinkingChoices(plain, catalogLevels))
        // Модель без карты (её нет в каталоге, ещё не выбрана) — общий список:
        // пустой пикер хуже, чем неполный.
        assertEquals(catalogLevels, thinkingChoices(null, catalogLevels))
        assertEquals(catalogLevels, thinkingChoices(ModelRef(provider = "x", id = "y"), catalogLevels))
    }

    @Test
    fun chipsShowTheOfficialPiNamesOnly() {
        // Карта Pi (minimal→low, xhigh→high) в подписи не показывается: рядом стояли
        // пары «Minimal → low» и «Xhigh → high», которые читаются как противоречие.
        assertEquals("None", thinkingLabel("off"))
        assertEquals("Minimal", thinkingLabel("minimal"))
        assertEquals("Low", thinkingLabel("low"))
        assertEquals("Medium", thinkingLabel("medium"))
        assertEquals("High", thinkingLabel("high"))
        assertEquals("Xhigh", thinkingLabel("xhigh"))
        assertEquals("Max", thinkingLabel("max"))
        // Неизвестное значение показывается как есть, чтобы не прятать его.
        assertEquals("super", thinkingLabel("super"))
    }

    @Test
    fun switchingModelClampsTheChosenLevel() {
        // «Минимум» у Strata невалиден: поднимаемся вверх до ближайшего (low).
        assertEquals("low", clampThinkingLevel("minimal", strata.thinkingLevels))
        // «Предел» (max) у Strata тоже null: вверх некуда, идём вниз — xhigh.
        assertEquals("xhigh", clampThinkingLevel("max", strata.thinkingLevels))
        // Поддерживаемый уровень не меняется.
        assertEquals("medium", clampThinkingLevel("medium", strata.thinkingLevels))
        assertEquals("high", clampThinkingLevel("high", plain.thinkingLevels))
        // Неизвестное значение — берём первый доступный уровень.
        assertEquals("off", clampThinkingLevel("nonsense", strata.thinkingLevels))
        // Уровень не выбран (Pi сам решит) — так и остаётся.
        assertNull(clampThinkingLevel(null, strata.thinkingLevels))
        // Список неизвестен: выбор пользователя не трогаем.
        assertEquals("high", clampThinkingLevel("high", emptyList()))
    }
}
