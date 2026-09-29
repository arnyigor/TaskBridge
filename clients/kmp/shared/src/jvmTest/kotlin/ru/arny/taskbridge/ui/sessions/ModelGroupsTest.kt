package ru.arny.taskbridge.ui.sessions

import ru.arny.taskbridge.core.api.ModelRef
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Локальные модели (пресеты llama.cpp-роутера и внешние серверы Strata) имеют
 * разные Pi-провайдеры, но одна машина: пикер обязан показывать их одной группой,
 * иначе список распадается на «llama.cpp», «strata-iq2», «strata-iq3».
 */
class ModelGroupsTest {
    private val models = listOf(
        ModelRef(provider = "llama.cpp", id = "qwen-27b-q3"),
        ModelRef(provider = "strata-iq3", id = "qwen3.8-flash-next-iq3-xxs", local = true),
        ModelRef(provider = "strata-iq2", id = "qwen3.8-flash-next-iq2-xs", local = true),
        ModelRef(provider = "openrouter", id = "glm-5"),
        ModelRef(provider = "deepseek", id = "deepseek-chat"),
    )

    @Test
    fun localModelsFormOneGroupPlacedBeforeTheProviders() {
        val groups = modelGroups(models, emptySet())
        assertEquals(
            listOf("Локальные модели", "deepseek", "llama.cpp", "openrouter"),
            groups.map { it.first },
        )
        // В общую группу попадают только модели с флагом local; роутер без флага
        // остаётся в своей группе — признак считает сервер, а не имя провайдера.
        assertEquals(listOf("qwen3.8-flash-next-iq3-xxs", "qwen3.8-flash-next-iq2-xs"), groups.first().second.map { it.id })
    }

    @Test
    fun favoritesStayFirstAndHideTheRowInTheirOwnGroup() {
        val groups = modelGroups(models, setOf("strata-iq3/qwen3.8-flash-next-iq3-xxs"))
        assertEquals(listOf("★ Избранное", "Локальные модели", "deepseek", "llama.cpp", "openrouter"), groups.map { it.first })
        assertEquals(listOf("qwen3.8-flash-next-iq3-xxs"), groups[0].second.map { it.id })
        assertEquals(listOf("qwen3.8-flash-next-iq2-xs"), groups[1].second.map { it.id })
        assertEquals(models.size, groups.sumOf { it.second.size })
    }

    @Test
    fun modelWithoutAProviderKeepsItsOwnGroup() {
        val groups = modelGroups(listOf(ModelRef(id = "orphan"), ModelRef(provider = "wormsoft", id = "w", local = true)), emptySet())
        assertEquals(listOf("Локальные модели", "—"), groups.map { it.first })
    }
}
