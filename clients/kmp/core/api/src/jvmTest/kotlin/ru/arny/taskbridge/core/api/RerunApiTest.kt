package ru.arny.taskbridge.core.api

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * MR-07: повтор ответа с параметрами. Проверяется и тело запроса, и правило «чего не
 * задали — того не отправляем»: модель и уровень применяются к сессии, поэтому
 * подставленное по умолчанию поле молча сбросило бы выбор оператора.
 */
class RerunApiTest {
    private val requests = mutableListOf<HttpRequestData>()

    private fun api(handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData): TaskBridgeApi =
        TaskBridgeApi(HttpClient(MockEngine { request -> requests += request; handler(request) }), SimpleConnection("http://pc:8787"))

    private fun MockRequestHandleScope.json(text: String) =
        respond(ByteReadChannel(text), HttpStatusCode.OK, headersOf(HttpHeaders.ContentType to listOf("application/json")))

    private fun HttpRequestData.bodyText(): String = (body as? TextContent)?.text ?: ""

    private val task = """{"id":"t 1","status":"SUCCEEDED","projectId":"p1","prompt":"второе"}"""

    @Test
    fun theRerunCarriesTheChosenModelAndLevel() = runBlocking<Unit> {
        val api = api { json(task) }
        val updated = api.rerun(
            "t 1",
            "assistant-7",
            model = ModelRef(provider = "other", id = "other"),
            thinkingLevel = "low",
        )
        val request = requests.single()
        assertEquals(HttpMethod.Post, request.method)
        assertEquals("http://pc:8787/api/tasks/t%201/rerun", request.url.toString())
        val body = TaskBridgeJson.parseToJsonElement(request.bodyText()).jsonObject
        assertEquals("assistant-7", body["turnId"]!!.jsonPrimitive.content)
        assertEquals("other", body["model"]!!.jsonObject["provider"]!!.jsonPrimitive.content)
        assertEquals("other", body["model"]!!.jsonObject["id"]!!.jsonPrimitive.content)
        assertEquals("low", body["thinkingLevel"]!!.jsonPrimitive.content)
        assertEquals("t 1", updated.id)
    }

    @Test
    fun withoutParametersOnlyTheTurnIsSent() = runBlocking<Unit> {
        val api = api { json(task) }
        api.rerun("t1", "assistant-3")
        val body = TaskBridgeJson.parseToJsonElement(requests.single().bodyText()).jsonObject
        assertEquals("assistant-3", body["turnId"]!!.jsonPrimitive.content)
        assertTrue("model" !in body, "модель не названа — сервер не трогает ту, что стоит: $body")
        assertTrue("thinkingLevel" !in body, "уровень не назван — остаётся прежний: $body")
    }

    @Test
    fun aModelWithoutAProviderIsStillSentWithItsId() = runBlocking<Unit> {
        val api = api { json(task) }
        api.rerun("t1", "assistant-3", model = ModelRef(id = "qwen3.8-flash-next-iq3-s"))
        val model = TaskBridgeJson.parseToJsonElement(requests.single().bodyText()).jsonObject["model"]!!.jsonObject
        assertEquals("qwen3.8-flash-next-iq3-s", model["id"]!!.jsonPrimitive.content)
        assertTrue("provider" !in model, "provider не задан — не выдумываем его на клиенте: $model")
    }
}
