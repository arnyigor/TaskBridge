package ru.arny.taskbridge.core.api

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

class ModelProbeApiTest {
    @Test
    fun `latency probe sends the selected model and decodes its explicit cost`() = runBlocking<Unit> {
        var captured: HttpRequestData? = null
        val http = HttpClient(MockEngine { request ->
            captured = request
            respond(
                """{"mode":"latency","ok":true,"ms":321,"tokensUsed":1,"httpStatus":200}""",
                HttpStatusCode.OK,
                headersOf(HttpHeaders.ContentType, "application/json"),
            )
        })
        try {
            val api = TaskBridgeApi(http, SimpleConnection("http://pc:8787"))
            val result = api.probeModel("provider-a", "model-b")
            val request = captured ?: error("request not captured")
            val body = TaskBridgeJson.parseToJsonElement((request.body as TextContent).text).jsonObject

            assertEquals(HttpMethod.Post, request.method)
            assertEquals("/api/models/probe", request.url.encodedPath)
            assertEquals("provider-a", body["provider"]?.jsonPrimitive?.content)
            assertEquals("model-b", body["id"]?.jsonPrimitive?.content)
            assertEquals("latency", body["mode"]?.jsonPrimitive?.content)
            assertEquals(321L, result.ms)
            assertEquals(1, result.tokensUsed)
        } finally {
            http.close()
        }
    }

    @Test
    fun `a refusal remains a refusal instead of a fake latency`() = runBlocking<Unit> {
        val http = HttpClient(MockEngine {
            respond(
                """{"mode":"latency","ok":false,"code":"COOLDOWN","retryInMs":4100}""",
                HttpStatusCode.OK,
                headersOf(HttpHeaders.ContentType, "application/json"),
            )
        })
        try {
            val result = TaskBridgeApi(http, SimpleConnection("http://pc:8787")).probeModel("p", "m")
            assertFalse(result.ok)
            assertEquals("COOLDOWN", result.code)
            assertEquals(4100L, result.retryInMs)
        } finally {
            http.close()
        }
    }
}
