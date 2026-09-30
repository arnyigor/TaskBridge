package ru.arny.taskbridge.ui.settings

import ru.arny.taskbridge.core.api.ModelRef
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Список провайдеров в настройках показывает один ПК, а не список Pi-провайдеров:
 * три кванта одной установки Strata (`strata-iq2`, `strata-iq3`, `strata-iq3s`)
 * сходятся в одну строку «strata» со счётчиком 3, иначе одна машина выглядит как
 * три разных движка. Облачные провайдеры не сливаются: `local` у них не выставлен.
 */
class ProviderCountsTest {
    private val models = listOf(
        ModelRef(provider = "deepseek", id = "deepseek-chat"),
        ModelRef(provider = "deepseek", id = "deepseek-reasoner"),
        ModelRef(provider = "strata-iq2", id = "qwen3.8-flash-next-iq2-xs", local = true),
        ModelRef(provider = "strata-iq3", id = "qwen3.8-flash-next-iq3-xxs", local = true),
        ModelRef(provider = "strata-iq3s", id = "qwen3.8-flash-next-iq3-s", local = true),
        // Локальный, но без дефиса: имя роутера остаётся как есть.
        ModelRef(provider = "llama.cpp", id = "qwen-27b-q3", local = true),
    )

    @Test
    fun localQuantsOfOneEngineBecomeOneRowNamedStrata() {
        assertEquals(
            listOf("strata" to 3, "deepseek" to 2, "llama.cpp" to 1),
            providerModelCounts(models),
        )
    }

    @Test
    fun aCloudProviderKeepsItsFullName() {
        // Тот же дефис, но без флага local: имя провайдера — имя аккаунта.
        assertEquals(
            listOf("some-cloud" to 1),
            providerModelCounts(listOf(ModelRef(provider = "some-cloud", id = "m"))),
        )
    }

    @Test
    fun modelsWithoutAProviderAreCountedTogether() {
        assertEquals(
            listOf("другие" to 2),
            providerModelCounts(listOf(ModelRef(id = "a"), ModelRef(id = "b"))),
        )
    }
}
