package ru.arny.taskbridge.ui.sessions

import ru.arny.taskbridge.core.api.ModelCatalog
import ru.arny.taskbridge.core.api.ModelRef
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Уровни размышлений, когда у задачи нет своей карты модели.
 *
 * Регрессия 2026-11-11: сервер сокращает модель задачи до provider/id (и в списке,
 * и в живом состоянии Pi), поэтому `thinkingLevels` приходили пустыми, пикер падал
 * на общий список каталога `['off']` и показывал единственный «None» — «выбора нет».
 */
class ThinkingChoicesCatalogTest {

    private val full = listOf("off", "minimal", "low", "medium", "high", "xhigh", "max")
    private val strata = listOf("off", "low", "medium", "high")

    private val catalog = ModelCatalog(
        models = listOf(
            ModelRef(provider = "deepseek", id = "deepseek-flash", reasoning = true, thinkingLevels = full),
            ModelRef(provider = "strata", id = "qwen3.8-flash-next-iq3_s", reasoning = false, thinkingLevels = listOf("off")),
            ModelRef(provider = "strata", id = "local-thinking", reasoning = true, thinkingLevels = strata),
        ),
        // Общий список каталога относится к модели Pi по умолчанию и здесь бесполезен.
        thinkingLevels = listOf("off"),
    )

    @Test
    fun levelListWithoutMapFallsBackToTheCatalogEntry() {
        val lean = ModelRef(provider = "deepseek", id = "deepseek-flash") // как в списке задач
        assertEquals(full, thinkingChoices(lean, catalog))
        assertTrue(thinkingLevelsShown(lean, catalog))
    }

    @Test
    fun aReasoningModelFromTheListIsNotHidden() {
        val lean = ModelRef(provider = "strata", id = "local-thinking")
        assertEquals(strata, thinkingChoices(lean, catalog))
        assertTrue(thinkingLevelsShown(lean, catalog), "признак reasoning берётся из каталога")
    }

    @Test
    fun aModelThatCannotThinkStillShowsNoLevels() {
        val lean = ModelRef(provider = "strata", id = "qwen3.8-flash-next-iq3_s")
        assertEquals(listOf("off"), thinkingChoices(lean, catalog))
        assertFalse(thinkingLevelsShown(lean, catalog))
    }

    @Test
    fun ownMapWinsOverTheCatalog() {
        val own = ModelRef(provider = "deepseek", id = "deepseek-flash", reasoning = true, thinkingLevels = listOf("off", "high"))
        assertEquals(listOf("off", "high"), thinkingChoices(own, catalog))
    }

    @Test
    fun unknownModelKeepsTheGlobalFallback() {
        val unknown = ModelRef(provider = "nowhere", id = "ghost")
        assertEquals(listOf("off"), thinkingChoices(unknown, catalog))
        assertTrue(thinkingLevelsShown(unknown, catalog), "неизвестность не повод прятать пикер")
    }

    @Test
    fun noCatalogAtAllDoesNotCrash() {
        // Каталог не загрузился: уровней взять негде — пустой пикер не рисуем.
        assertEquals(emptyList(), thinkingChoices(ModelRef(provider = "x", id = "y"), null))
        assertFalse(thinkingLevelsShown(ModelRef(provider = "x", id = "y"), null))
    }
}
