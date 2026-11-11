package ru.arny.taskbridge.core.client

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.api.SimpleConnection
import ru.arny.taskbridge.core.client.settings.PiModelsController
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PiModelsProbeTest {
    @Test
    fun probeIsExplicitDeduplicatedAndResultBelongsToModel() = runBlocking {
        var probes = 0
        val gate = CompletableDeferred<Unit>()
        val http = HttpClient(MockEngine { request ->
            val content = when {
                request.url.encodedPath.endsWith("/raw") -> """{"revision":"r1","entry":{"models":[{"id":"model-a"}]}}"""
                request.url.encodedPath.endsWith("/probe") -> {
                    probes++
                    gate.await()
                    """{"ok":true,"ms":123,"tokensUsed":1}"""
                }
                else -> error("Unexpected request ${request.url}")
            }
            respond(content, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        })
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val controller = PiModelsController(TaskBridgeApi(http, SimpleConnection("http://pc:8787", clientId = "probe-test")), scope)
        controller.openProvider("test-provider")
        withTimeout(5000) { controller.state.first { !it.loading } }
        assertEquals(0, probes, "Opening provider must not spend tokens")
        controller.testModel("model-a")
        controller.testModel("model-a")
        assertTrue(controller.state.value.modelProbes["test-provider" to "model-a"]!!.loading)
        gate.complete(Unit)
        val completed = withContext(Dispatchers.Default) {
            withTimeout(5000) {
                controller.state.first { it.modelProbes["test-provider" to "model-a"]?.loading == false }
            }
        }
        val result = completed.modelProbes["test-provider" to "model-a"]!!
        assertEquals(false, result.loading)
        assertEquals(true, result.result?.ok)
        assertEquals(123L, result.result?.ms)
        assertEquals(1, probes)
        scope.cancel()
        http.close()
    }
}
