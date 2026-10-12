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
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * MR-01: the project dashboard over the wire. The screen depends on these three
 * shapes, so the URL, the query and the PATCH body are pinned here.
 */
class ProjectDashboardApiTest {
    private val requests = mutableListOf<HttpRequestData>()

    private fun api(handler: suspend MockRequestHandleScope.(HttpRequestData) -> io.ktor.client.request.HttpResponseData): TaskBridgeApi =
        TaskBridgeApi(HttpClient(MockEngine { request -> requests += request; handler(request) }), SimpleConnection("http://pc:8787"))

    private fun MockRequestHandleScope.json(text: String) =
        respond(ByteReadChannel(text), HttpStatusCode.OK, headersOf(HttpHeaders.ContentType to listOf("application/json")))

    private fun HttpRequestData.bodyText(): String = (body as? TextContent)?.text ?: ""

    @Test
    fun theOverviewCarriesCountsPinnedAndUnassigned() = runBlocking<Unit> {
        val api = api {
            json(
                """
                {"projects":[
                  {"id":"taskbridge","name":"TaskBridge","path":"G:/p","useWorktree":true,
                   "pinned":true,"archived":false,"sessions":92,"working":1,
                   "lastActivityAt":"2026-10-11T07:20:00.000Z"},
                  {"id":"old","archived":true,"sessions":0}
                ],"unassignedSessions":3,
                "totals":{"projects":2,"pinned":1,"archived":1,"sessions":95,"working":1}}
                """.trimIndent(),
            )
        }
        val overview = api.projectOverview()
        assertEquals("http://pc:8787/api/projects/overview", requests.single().url.toString())
        assertEquals(2, overview.projects.size)
        val first = overview.projects.first()
        assertEquals("taskbridge", first.id)
        assertEquals("TaskBridge", first.displayName)
        assertTrue(first.pinned)
        assertFalse(first.archived)
        assertEquals(92, first.sessions)
        assertEquals(1, first.working)
        assertEquals("2026-10-11T07:20:00.000Z", first.lastActivityAt)
        assertTrue(overview.projects.last().archived)
        assertEquals(3, overview.unassignedSessions)
        assertEquals(95, overview.totals.sessions)
        // A project with no name at all still has something to show.
        assertEquals("old", overview.projects.last().displayName)
    }

    @Test
    fun theSessionPageIsFilteredServerSide() = runBlocking<Unit> {
        val api = api {
            json(
                """
                {"projectId":"p 1","registered":false,"total":42,"offset":10,"limit":5,"endReached":false,
                 "items":[{"id":"t1","title":"первая","status":"SUCCEEDED"}]}
                """.trimIndent(),
            )
        }
        val page = api.projectSessions("p 1", query = "второй вопрос", status = "SUCCEEDED", sort = "created", limit = 5, offset = 10)
        val url = requests.single().url.toString()
        assertEquals(
            "http://pc:8787/api/projects/p%201/sessions?q=%D0%B2%D1%82%D0%BE%D1%80%D0%BE%D0%B9%20%D0%B2%D0%BE%D0%BF%D1%80%D0%BE%D1%81" +
                "&status=SUCCEEDED&sort=created&limit=5&offset=10",
            url,
        )
        assertEquals(42, page.total)
        assertFalse(page.registered, "a removed registration still answers with its sessions")
        assertEquals("t1", page.items.single().id)

        // No filters at all must not leave a dangling '?'.
        requests.clear()
        api.projectSessions("p1")
        assertEquals("http://pc:8787/api/projects/p1/sessions", requests.single().url.toString())
    }

    @Test
    fun pinningSendsOnlyTheFlagItChanges() = runBlocking<Unit> {
        val api = api {
            json("""{"pinned":true,"archived":false,"updatedAt":"2026-10-11T07:20:00.000Z"}""")
        }
        val preferences = api.setProjectPreferences("p 1", pinned = true)
        val request = requests.single()
        assertEquals(HttpMethod.Patch, request.method)
        assertEquals("http://pc:8787/api/projects/p%201/preferences", request.url.toString())
        val body = TaskBridgeJson.parseToJsonElement(request.bodyText()).jsonObject
        assertEquals("true", body["pinned"]!!.jsonPrimitive.content)
        assertTrue("archived" !in body, "an absent flag keeps its stored value on the server: $body")
        assertTrue(preferences.pinned)
        assertFalse(preferences.archived)
    }
}
