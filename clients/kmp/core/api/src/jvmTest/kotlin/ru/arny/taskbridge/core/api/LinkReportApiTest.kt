package ru.arny.taskbridge.core.api

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

class LinkReportApiTest {

    private fun api(body: String, onRequest: (String, String) -> Unit): TaskBridgeApi {
        val engine = MockEngine { request ->
            onRequest(request.url.encodedPath, request.bodyText())
            respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        return TaskBridgeApi(
            HttpClient(engine),
            SimpleConnection("http://pc:8787", clientId = "android-42"),
        )
    }

    @Test
    fun theReportGoesToTheClientsLinkRouteWithStateAndClientId() = runBlocking<Unit> {
        var path = ""
        var payload = ""
        val api = api("""{"clientId":"android-42","state":"degraded"}""") { seenPath, seenBody -> path = seenPath; payload = seenBody }
        api.reportLinkState("degraded", "stream closed", 2)
        assertEquals("/api/clients/link", path)
        val json = Json.parseToJsonElement(payload).jsonObject
        assertEquals("degraded", json["state"]?.jsonPrimitive?.content)
        assertEquals("android-42", json["clientId"]?.jsonPrimitive?.content)
        assertEquals("stream closed", json["reason"]?.jsonPrimitive?.content)
        assertEquals("2", json["attempt"]?.jsonPrimitive?.content)
        // Содержимого сессии в теле быть не должно: это метрика, а не канал данных.
        assertFalse(payload.contains("\"events\""))
        assertFalse(payload.contains("prompt"))
    }

    @Test
    fun liveReportsNeedNoReasonOrAttempt() = runBlocking<Unit> {
        var payload = ""
        val api = api("""{"clientId":"android-42","state":"live"}""") { _, seenBody -> payload = seenBody }
        api.reportLinkState("live")
        val json = Json.parseToJsonElement(payload).jsonObject
        assertEquals("live", json["state"]?.jsonPrimitive?.content)
        assertEquals(null, json["reason"])
        assertEquals(null, json["attempt"])
    }
}

/** Тело запроса как строка: MockEngine даёт его как OutgoingContent. */
private suspend fun io.ktor.client.request.HttpRequestData.bodyText(): String =
    (body as? io.ktor.http.content.TextContent)?.text ?: ""
