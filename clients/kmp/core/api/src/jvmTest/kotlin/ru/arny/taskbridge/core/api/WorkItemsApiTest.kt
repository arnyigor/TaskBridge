package ru.arny.taskbridge.core.api

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * MR-02: work items over the wire. The screen depends on these shapes, so the URL,
 * the query and the body of POST/PATCH are pinned here — including the rule that a
 * field left out keeps its value, and that clearing the goal needs its own flag.
 */
class WorkItemsApiTest {
    private val requests = mutableListOf<HttpRequestData>()

    private fun api(handler: suspend MockRequestHandleScope.(HttpRequestData) -> io.ktor.client.request.HttpResponseData): TaskBridgeApi =
        TaskBridgeApi(HttpClient(MockEngine { request -> requests += request; handler(request) }), SimpleConnection("http://pc:8787"))

    private fun MockRequestHandleScope.json(text: String) =
        respond(ByteReadChannel(text), HttpStatusCode.OK, headersOf(HttpHeaders.ContentType to listOf("application/json")))

    private fun HttpRequestData.bodyText(): String = (body as? TextContent)?.text ?: ""

    private val item = """
        {"id":"wi-1","projectId":"p 1","title":"Project Dashboard","goal":"цель","status":"IN_PROGRESS",
         "priority":2,"acceptanceCriteria":["обзор","архив"],"tags":["ui"],
         "createdAt":"2026-10-11T10:00:00.000Z","updatedAt":"2026-10-11T11:00:00.000Z","completedAt":null}
    """.trimIndent()

    @Test
    fun theListIsFilteredServerSideAndTheListsAreDecoded() = runBlocking<Unit> {
        val api = api { json("""{"items":[$item]}""") }
        val items = api.workItems(projectId = "p 1", status = "IN_PROGRESS", includeClosed = false)
        assertEquals(
            "http://pc:8787/api/work-items?projectId=p%201&status=IN_PROGRESS&includeClosed=0",
            requests.single().url.toString(),
        )
        val one = items.single()
        assertEquals("wi-1", one.id)
        assertEquals("цель", one.goal)
        assertEquals(2, one.priority)
        assertEquals(listOf("обзор", "архив"), one.acceptanceCriteria, "критерии приходят списком")
        assertEquals(listOf("ui"), one.tags)
        assertTrue(one.open, "IN_PROGRESS — открытая работа")

        requests.clear()
        api.workItems()
        assertEquals("http://pc:8787/api/work-items", requests.single().url.toString(), "без фильтров лишних параметров нет")
    }

    @Test
    fun creatingSendsOnlyWhatTheCallerSet() = runBlocking<Unit> {
        val api = api { json(item) }
        api.createWorkItem(WorkItemRequest(projectId = "p 1", title = "Project Dashboard", priority = 2))
        val request = requests.single()
        assertEquals(HttpMethod.Post, request.method)
        assertEquals("http://pc:8787/api/work-items", request.url.toString())
        val body = TaskBridgeJson.parseToJsonElement(request.bodyText()).jsonObject
        assertEquals("p 1", body["projectId"]!!.jsonPrimitive.content)
        assertEquals("Project Dashboard", body["title"]!!.jsonPrimitive.content)
        assertEquals("2", body["priority"]!!.jsonPrimitive.content)
        assertTrue("status" !in body, "статус не задан — сервер поставит BACKLOG: $body")
        assertTrue("goal" !in body, "и пустая цель не отправляется: $body")
    }

    @Test
    fun patchingKeepsTheFieldsItDoesNotMentionAndCanClearTheGoal() = runBlocking<Unit> {
        val api = api { json(item) }
        api.updateWorkItem("wi-1", WorkItemRequest(status = "DONE", acceptanceCriteria = listOf("готова")))
        val request = requests.single()
        assertEquals(HttpMethod.Patch, request.method)
        assertEquals("http://pc:8787/api/work-items/wi-1", request.url.toString())
        val body = TaskBridgeJson.parseToJsonElement(request.bodyText()).jsonObject
        assertEquals("DONE", body["status"]!!.jsonPrimitive.content)
        assertEquals(1, body["acceptanceCriteria"]!!.jsonArray.size)
        assertTrue("title" !in body, "заголовок не тронут: $body")
        assertTrue("goal" !in body, "цель не тронута: $body")

        // `null` means «do not change» on the wire, so clearing needs the flag.
        requests.clear()
        api.updateWorkItem("wi-1", WorkItemRequest(clearGoal = true))
        val clearing = TaskBridgeJson.parseToJsonElement(requests.single().bodyText()).jsonObject
        assertTrue("goal" in clearing, "очистка цели должна уходить на сервер: $clearing")
        assertEquals("null", clearing["goal"]!!.jsonPrimitive.content)
    }

    @Test
    fun deletingAnswersWithTheItemItRemoved() = runBlocking<Unit> {
        val api = api { json("""{"ok":true,"removed":$item}""") }
        val removed = api.deleteWorkItem("wi-1")
        assertEquals(HttpMethod.Delete, requests.single().method)
        assertEquals("wi-1", removed.id)
        assertEquals("IN_PROGRESS", removed.status, "удаление возвращает саму задачу, а не пустоту")
        assertTrue(removed.open)
    }

    // MR-03: a work item gathers sessions, and the session knows its work items.
    @Test
    fun sessionsAreLinkedAndReadFromBothSides() = runBlocking<Unit> {
        val linked = """
            {"workItemId":"wi-1","sessionId":"s 1","relation":"review",
             "createdAt":"2026-10-11T12:00:00.000Z","available":true,"status":"SUCCEEDED","title":"android часть"}
        """.trimIndent()
        val api = api { request ->
            if (request.url.encodedPath.endsWith("/sessions")) json(linked) else json(item)
        }

        val link = api.linkWorkItemSession("wi-1", "s 1", relation = "review")
        val request = requests.single()
        assertEquals(HttpMethod.Post, request.method)
        assertEquals("http://pc:8787/api/work-items/wi-1/sessions", request.url.toString())
        val body = TaskBridgeJson.parseToJsonElement(request.bodyText()).jsonObject
        assertEquals("s 1", body["sessionId"]!!.jsonPrimitive.content)
        assertEquals("review", body["relation"]!!.jsonPrimitive.content)
        assertEquals("review", link.relation)
        assertTrue(link.available, "сессия на месте — связь можно открыть")

        requests.clear()
        api.workItemSessions("wi-1")
        assertEquals("http://pc:8787/api/work-items/wi-1/sessions", requests.single().url.toString())

        requests.clear()
        api.workItemDetail("wi-1")
        assertEquals("http://pc:8787/api/work-items/wi-1", requests.single().url.toString())
    }

    @Test
    fun unlinkingAndTheSessionsOwnWorkItemsUseTheRightRoutes() = runBlocking<Unit> {
        val api = api { request ->
            when {
                request.method == HttpMethod.Delete -> json("""{"removed":true}""")
                else -> json("""{"items":[{"id":"wi-1","projectId":"p 1","title":"Задача","status":"IN_PROGRESS","relation":"implementation"}]}""")
            }
        }
        assertTrue(api.unlinkWorkItemSession("wi-1", "s 1"), "связь снята")
        assertEquals(HttpMethod.Delete, requests.single().method)
        assertEquals("http://pc:8787/api/work-items/wi-1/sessions/s%201", requests.single().url.toString())

        requests.clear()
        val items = api.workItemsOfSession("s 1")
        assertEquals("http://pc:8787/api/tasks/s%201/work-items", requests.single().url.toString())
        assertEquals("wi-1", items.single().id)
        assertEquals("implementation", items.single().relation)
    }
}
