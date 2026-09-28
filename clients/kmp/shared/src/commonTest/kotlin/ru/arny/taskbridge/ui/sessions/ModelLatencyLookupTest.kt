package ru.arny.taskbridge.ui.sessions

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import ru.arny.taskbridge.core.api.ModelCatalog
import ru.arny.taskbridge.core.api.ModelLatency
import ru.arny.taskbridge.core.api.ModelRef

class ModelLatencyLookupTest {
    private val latency = ModelLatency(count = 3, avgMs = 2000, p50Ms = 1800, lastMs = 2400)

    /** The ordinary case: the key in the catalog is what the session's model reports. */
    @Test
    fun anExactProviderAndIdFindsTheSample() {
        val catalog = ModelCatalog(latency = mapOf("deepseek/deepseek-v4-pro" to latency))
        assertEquals(latency, catalog.latencyFor(ModelRef(provider = "deepseek", id = "deepseek-v4-pro")))
    }

    /**
     * Pi reports the default model without a provider (`provider: null`), and the
     * server then files the sample as `/id` — the lookup still has to find it.
     */
    @Test
    fun aMissingProviderMatchesTheProviderLessKey() {
        val catalog = ModelCatalog(latency = mapOf("/fixture" to latency))
        assertEquals(latency, catalog.latencyFor(ModelRef(provider = null, id = "fixture")))
    }

    /**
     * For the local router Pi and models.json disagree about the provider id
     * ("llama.cpp" against "llamacpp", see resolveLocalProviderId), so the same
     * model id under another provider still has to resolve.
     */
    @Test
    fun aDriftedProviderIdFallsBackToTheModelId() {
        val catalog = ModelCatalog(latency = mapOf("llama.cpp/qwen-27b-q3" to latency))
        assertEquals(latency, catalog.latencyFor(ModelRef(provider = "llamacpp", id = "qwen-27b-q3")))
    }

    /** An exact key wins over another provider that offers the same model id. */
    @Test
    fun theExactProviderWinsOverAnotherOne() {
        val other = ModelLatency(count = 1, lastMs = 99)
        val catalog = ModelCatalog(latency = mapOf("openai/gpt-4" to other, "azure/gpt-4" to latency))
        assertEquals(latency, catalog.latencyFor(ModelRef(provider = "azure", id = "gpt-4")))
    }

    @Test
    fun noSamplesAndNoModelGiveNothing() {
        assertNull(ModelCatalog().latencyFor(ModelRef(provider = "deepseek", id = "deepseek-v4-pro")))
        assertNull(ModelCatalog(latency = mapOf("/fixture" to latency)).latencyFor(null))
        assertNull(ModelCatalog(latency = mapOf("/fixture" to latency)).latencyFor(ModelRef(provider = null, id = null)))
    }
}
