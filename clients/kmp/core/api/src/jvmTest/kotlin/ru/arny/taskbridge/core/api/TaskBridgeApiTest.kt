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
    fun pairingWithAnOldServerKeepsTheCookieAndSendsItAfterwards() = runBlocking<Unit> {
        val connection = SimpleConnection("http://pc:8787", clientId = "android-1a2b3c4d")
        val api = api(connection) { request ->
            if (request.url.encodedPath == "/api/auth/pair") json("""{"ok":true}""", HttpStatusCode.OK,
                HttpHeaders.SetCookie to listOf("taskbridge_session=123.abc.sig; Path=/; HttpOnly; SameSite=Strict; Max-Age=2678400"))
            else json(Fixtures.text("tasks.json"))
        }
        api.pair(" 123456 ")
        assertEquals("123.abc.sig", connection.sessionCookie)
        assertEquals(null, connection.authToken)
        api.tasks()
        assertEquals("taskbridge_session=123.abc.sig", requests.last().headers[HttpHeaders.Cookie])
        assertEquals("""{"code":"123456","deviceName":"android-1a2b3c4d","clientKind":"android"}""", requests.first().bodyText())
    }

    @Test
    fun pairingKeepsTheDeviceTokenAndSendsItAsBearer() = runBlocking<Unit> {
        val token = "ab".repeat(32)
        val connection = SimpleConnection("http://pc:8787", sessionCookie = "old.cookie.sig", clientId = "desktop-99")
        val api = api(connection) { request ->
            if (request.url.encodedPath == "/api/auth/pair") json("""{"ok":true,"deviceId":"d_1","token":"$token"}""", HttpStatusCode.OK,
                HttpHeaders.SetCookie to listOf("taskbridge_session=$token; Path=/; HttpOnly"))
            else json(Fixtures.text("tasks.json"))
        }
        api.pair("12345678")
        assertEquals(token, connection.authToken)
        assertEquals(null, connection.sessionCookie, "the token replaces a stale cookie")
        api.tasks()
        assertEquals("Bearer $token", requests.last().headers[HttpHeaders.Authorization])
        assertEquals(null, requests.last().headers[HttpHeaders.Cookie])
        assertTrue(requests.first().bodyText().contains("\"clientKind\":\"desktop\""))
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
    fun projectBrowserUsesServerPathsAndRegistersTheChosenFolder() = runBlocking<Unit> {
        val api = api { request ->
            when (request.url.encodedPath) {
                "/api/project-browser" -> json("""{"path":"G:\\AIModels","parent":null,"entries":[{"name":"Other","path":"G:\\AIModels\\Other"}]}""")
                "/api/project-browser/register" -> json("""{"id":"other","name":"Other","path":"G:\\AIModels\\Other"}""", HttpStatusCode.Created)
                else -> error("Unexpected route: ${request.url}")
            }
        }
        val path = "G:\\AIModels\\Other"
        val listing = api.projectFolders(path)
        assertEquals("Other", listing.entries.single().name)
        assertEquals(path, requests.first().url.parameters["path"])
        val project = api.registerProject(path, "Other")
        assertEquals("other", project.id)
        assertEquals(path, TaskBridgeJson.parseToJsonElement(requests.last().bodyText()).jsonObject["path"]?.jsonPrimitive?.content)
    }

    @Test
    fun desktopFolderRegistrationUsesTheLocalOnlyEndpoint() = runBlocking<Unit> {
        val api = api { json("""{"id":"other","name":"Other","path":"G:\\Elsewhere"}""") }
        api.registerLocalProject("G:\\Elsewhere")
        assertEquals("/api/projects/local-register", requests.single().url.encodedPath)
        assertEquals("G:\\Elsewhere", TaskBridgeJson.parseToJsonElement(requests.single().bodyText()).jsonObject["path"]?.jsonPrimitive?.content)
    }

    @Test
    fun providerAndMcpManagementUseTypedEndpoints() = runBlocking<Unit> {
        val api = api { request ->
            when (request.url.encodedPath) {
                "/api/providers/refresh" -> json("""{"wormsoft":{"provider":"wormsoft","available":true,"kind":"subscription","subscription":{"plan":"paid","remaining":700,"total":1000}}}""")
                "/api/mcp" -> json("""{"mode":"managed","servers":[{"name":"serena","transport":"stdio","tools":[{"name":"search","description":"Find symbols"}]}]}""")
                "/api/mcp/tools" -> json("""{"mode":"managed","servers":[{"name":"serena","transport":"stdio","excludeTools":["search"],"tools":[{"name":"search"}]}]}""")
                else -> error("Unexpected route: ${request.url}")
            }
        }
        val statuses = api.refreshProvider("wormsoft")
        assertEquals(700.0, statuses.getValue("wormsoft").subscription?.remaining)
        assertEquals("wormsoft", TaskBridgeJson.parseToJsonElement(requests.first().bodyText()).jsonObject["provider"]?.jsonPrimitive?.content)

        val mcp = api.mcp()
        assertEquals("search", mcp.servers.single().tools.single().name)
        val changed = api.setMcpTool("serena", "search", enabled = false)
        assertEquals(listOf("search"), changed.servers.single().excludeTools)
        assertEquals("false", TaskBridgeJson.parseToJsonElement(requests.last().bodyText()).jsonObject["enabled"]?.jsonPrimitive?.content)
    }

    @Test
    fun taskDecodesPromptAndGenerationSpeeds() {
        val task = TaskBridgeJson.decodeFromString(
            Task.serializer(),
            """{"id":"speed","metrics":{"pp":321.5,"tg":47.25,"inputTokens":1200,"outputTokens":96,"promptMs":3733,"ms":2032,"source":"mixed","ppSource":"ttft-estimate","tgSource":"usage","ppApproximate":true}}""",
        )
        assertEquals(321.5, task.metrics?.pp)
        assertEquals(47.25, task.metrics?.tg)
        assertEquals(1200, task.metrics?.inputTokens)
        assertEquals("ttft-estimate", task.metrics?.ppSource)
        assertEquals(true, task.metrics?.ppApproximate)
    }

    @Test
    fun theSessionCookieIsReadFromSetCookie() {
        assertEquals("v.1.s", TaskBridgeApi.parseSessionCookie("taskbridge_session=v.1.s; Path=/"))
        assertEquals(null, TaskBridgeApi.parseSessionCookie("other=1"))
        assertEquals(null, TaskBridgeApi.parseSessionCookie("taskbridge_session=; Max-Age=0"))
    }

    @Test
    fun processesDecodeTheWrapperAndFreshAddsTheQuery() = runBlocking<Unit> {
        val api = api { request ->
            when {
                request.url.encodedPath != "/api/processes" -> json("""{"error":"Not found"}""", HttpStatusCode.NotFound)
                request.url.parameters["fresh"] == "1" -> json("""{"processes":[]}""")
                else -> json("""{"processes":[{"pid":1284,"name":"llama-server.exe","memoryBytes":16090427392,"startedAt":1791087506389,"commandLine":"llama-server --port 54107"}]}""")
            }
        }
        val list = api.processes()
        assertEquals(1, list.size)
        assertEquals(1284L, list.single().pid)
        assertEquals("llama-server.exe", list.single().name)
        assertEquals(16090427392L, list.single().memoryBytes)
        assertEquals("llama-server --port 54107", list.single().commandLine)
        assertEquals(listOf("/api/processes"), requests.map { it.url.encodedPath })
        val empty = api.processes(fresh = true)
        assertEquals(0, empty.size)
        // Пустой список — это {"processes":[]}, а не null: экран показывает «ОС не вернула процессов».
        assertEquals("1", requests.last().url.parameters["fresh"])
    }

    @Test
    fun killProcessPostsPidAndNameAndSurfacesTheServerRefusal() = runBlocking<Unit> {
        val api = api { request ->
            if (request.url.encodedPath == "/api/processes/kill") {
                json("""{"error":"«explorer.exe» — системный процесс, панель его не убивает.","code":"PROTECTED"}""", HttpStatusCode.Forbidden)
            } else json("""{}""")
        }
        val failure = assertFailsWith<ApiException> { api.killProcess(10068, "explorer.exe") }
        assertTrue(failure.message!!.contains("системный процесс"))
        val request = requests.single()
        assertEquals(HttpMethod.Post, request.method)
        assertEquals("/api/processes/kill", request.url.encodedPath)
        val body = TaskBridgeJson.parseToJsonElement(request.bodyText()).jsonObject
        assertEquals("10068", body["pid"]!!.jsonPrimitive.content)
        assertEquals("explorer.exe", body["name"]!!.jsonPrimitive.content)
    }
}
