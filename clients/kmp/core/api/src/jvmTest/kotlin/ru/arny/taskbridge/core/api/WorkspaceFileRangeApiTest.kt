package ru.arny.taskbridge.core.api

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/**
 * Пункт 162 плана: клик по ссылке `src/a.kt#L120-L140` в ответе агента должен
 * открывать файл на этих строках, поэтому диапазон обязан доехать до ЗАПРОСА,
 * а не остаться в UI. Серверная часть (`?from=&to=`) отдаёт только этот кусок.
 */
class WorkspaceFileRangeApiTest {

    private fun api(requested: MutableList<String>): TaskBridgeApi {
        val engine = MockEngine { request ->
            requested += request.url.toString()
            respond("two\nthree", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "text/plain"))
        }
        return TaskBridgeApi(HttpClient(engine), SimpleConnection("http://pc:8787", clientId = "range-test"))
    }

    @Test
    fun `a line range becomes from and to in the file request`() = runBlocking<Unit> {
        val requested = mutableListOf<String>()
        val api = api(requested)
        val bytes = api.download(api.workspaceFileUrl("t1", "src/a.kt", from = 120, to = 140))
        assertEquals("two\nthree", bytes.decodeToString())
        assertEquals(1, requested.size)
        val url = requested.single()
        assertContains(url, "path=src%2Fa.kt", message = url)
        assertContains(url, "&from=120", message = url)
        assertContains(url, "&to=140", message = url)
    }

    @Test
    fun `a single line is a one-line range and a plain file has no range at all`() {
        val api = api(mutableListOf())
        val single = api.workspaceFileUrl("t1", "src/a.kt", from = 7, to = null)
        assertContains(single, "&from=7")
        assertContains(single, "&to=7", message = "одна строка — диапазон из одной строки: $single")

        val plain = api.workspaceFileUrl("t1", "src/a.kt")
        assertFalse(plain.contains("from="), "без диапазона запрос остаётся прежним: $plain")
    }
}
