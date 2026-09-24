package ru.arny.taskbridge.core.api

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.OutgoingContent
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue

class TaskBridgeApiTest {
    private val requests = mutableListOf<HttpRequestData>()

    private fun api(
        connection: Connection = SimpleConnection("http://pc:8787/", clientId = "android-1"),
        handler: suspend MockRequestHandleScope.(HttpRequestData) -> io.ktor.client.request.HttpResponseData,
    ): TaskBridgeApi {
        val engine = MockEngine { request -> requests += request; handler(request) }
        return TaskBridgeApi(HttpClient(engine), connection)
    }

    private fun MockRequestHandleScope.json(text: String, status: HttpStatusCode = HttpStatusCode.OK, vararg headers: Pair<String, List<String>>) =
        respond(ByteReadChannel(text), status, headersOf(HttpHeaders.ContentType to listOf("application/json"), *headers))

    private fun HttpRequestData.bodyText(): String = (body as? TextContent)?.text ?: ""

    @Test
    fun aMessageCarriesItsCommandAndThisDevice() = runBlocking<Unit> {
        val api = api { json(Fixtures.text("task-with-queue.json")) }
        val task = api.message("t 1", MessageRequest(text = "привет", queue = true, commandId = "c-1"))
        assertEquals("из очереди", task.pendingPrompts.single().text)
        val request = requests.single()
        assertEquals(HttpMethod.Post, request.method)
        assertEquals("http://pc:8787/api/tasks/t%201/message", request.url.toString())
        val body = TaskBridgeJson.parseToJsonElement(request.bodyText()).jsonObject
        assertEquals("привет", body["text"]!!.jsonPrimitive.content)
        assertEquals("c-1", body["commandId"]!!.jsonPrimitive.content)
        assertEquals("android-1", body["clientId"]!!.jsonPrimitive.content)
        assertEquals("true", body["queue"]!!.jsonPrimitive.content)
        assertTrue((request.body as OutgoingContent).contentType.toString().startsWith("application/json"))
    }

    @Test
    fun pairingKeepsTheCookieAndSendsItAfterwards() = runBlocking<Unit> {
        val connection = SimpleConnection("http://pc:8787")
        val api = api(connection) { request ->
            if (request.url.encodedPath == "/api/auth/pair") json("""{"ok":true}""", HttpStatusCode.OK,
                HttpHeaders.SetCookie to listOf("taskbridge_session=123.abc.sig; Path=/; HttpOnly; SameSite=Strict; Max-Age=2678400"))
            else json(Fixtures.text("tasks.json"))
        }
        api.pair(" 123456 ")
        assertEquals("123.abc.sig", connection.sessionCookie)
        api.tasks()
        assertEquals("taskbridge_session=123.abc.sig", requests.last().headers[HttpHeaders.Cookie])
        assertEquals("""{"code":"123456"}""", requests.first().bodyText())
    }

    @Test
    fun failuresBecomeTypedErrors() = runBlocking<Unit> {
        val api = api { json(Fixtures.text("error-conflict.json").let { TaskBridgeJson.parseToJsonElement(it).jsonObject["body"].toString() }, HttpStatusCode.Conflict) }
        val error = assertFailsWith<ApiException> { api.message("t", MessageRequest(text = "x", commandId = "c")) }
        assertIs<ApiError.CommandConflict>(error.error)
        assertEquals("Команда уже принималась с другим содержимым.", error.message)
    }

    @Test
    fun anUnreachableDaemonIsNotAServerError() = runBlocking<Unit> {
        val api = api { throw java.net.ConnectException("Connection refused") }
        val error = assertFailsWith<ApiException> { api.info() }
        assertIs<ApiError.Unreachable>(error.error)
        assertTrue(error.error.transient)
    }

    @Test
    fun routesAndQueries() = runBlocking<Unit> {
        val api = api { request ->
            when {
                request.url.encodedPath.endsWith("/pending") -> json(Fixtures.text("task-succeeded.json"))
                request.url.encodedPath.endsWith("/events") -> json(Fixtures.text("events-tail.json"))
                else -> json("{}")
            }
        }
        api.dropPending("t", "p 1")
        assertEquals(HttpMethod.Delete, requests.last().method)
        assertEquals("pendingId=p+1", requests.last().url.encodedQuery.replace("%20", "+"))
        val window = api.eventWindow("t", tail = 2, before = 40)
        assertTrue(window.reachedStart)
        assertEquals("tail=2&before=40", requests.last().url.encodedQuery)
        api.answerApproval("t", "a1", allow = false)
        assertEquals("""{"decision":"DENY"}""", requests.last().bodyText())
    }

    @Test
    fun theSessionCookieIsReadFromSetCookie() {
        assertEquals("v.1.s", TaskBridgeApi.parseSessionCookie("taskbridge_session=v.1.s; Path=/"))
        assertEquals(null, TaskBridgeApi.parseSessionCookie("other=1"))
        assertEquals(null, TaskBridgeApi.parseSessionCookie("taskbridge_session=; Max-Age=0"))
    }
}
