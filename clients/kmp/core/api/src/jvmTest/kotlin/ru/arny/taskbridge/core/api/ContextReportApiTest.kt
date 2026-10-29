package ru.arny.taskbridge.core.api

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ContextReportApiTest {
    @Test
    fun nativeCompositionAndSummaryAreSeparateRequests() = runBlocking {
        val paths = mutableListOf<String>()
        val api = TaskBridgeApi(HttpClient(MockEngine { request ->
            paths += request.url.encodedPath
            val body = if (request.url.encodedPath.endsWith("/summary"))
                """{"available":true,"summary":"<img> untrusted summary","at":"2026-10-29T00:00:00Z"}"""
            else """{"taskId":"t1","session":{"available":true,"projectionVersion":"pi-1.4.0","branchSource":"pi-leaf","leafId":"leaf-a","checkpoint":{"messages":1,"chars":16},"active":{"retained":{"messages":2,"chars":20},"added":{"messages":3,"chars":30}},"compaction":{"summaryAvailable":true,"summaryChars":12}}}"""
            respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }), SimpleConnection("http://pc:8787"))
        val report = api.context("t1")
        assertEquals(listOf("/api/tasks/t1/context"), paths)
        assertEquals("pi-leaf", report.session?.branchSource)
        assertEquals("leaf-a", report.session?.leafId)
        assertEquals(16L, report.session?.checkpoint?.chars)
        assertEquals(2L, report.session?.active?.retained?.messages)
        assertEquals(3L, report.session?.active?.added?.messages)
        assertEquals("<img> untrusted summary", api.contextSummary("t1").summary)
        assertEquals(listOf("/api/tasks/t1/context", "/api/tasks/t1/context/summary"), paths)
    }

    @Test
    fun oldServerWithoutCompositionAndUnavailableSummaryKeepTheirMeaning() {
        val old = TaskBridgeJson.decodeFromString(SessionContextReport.serializer(), """{"taskId":"old","sources":[]}""")
        assertNull(old.session)
        val unavailable = TaskBridgeJson.decodeFromString(ContextSummary.serializer(), """{"available":false,"reason":"No compaction"}""")
        assertEquals(false, unavailable.available)
        assertNull(unavailable.summary)
        assertEquals("No compaction", unavailable.reason)
    }
}
