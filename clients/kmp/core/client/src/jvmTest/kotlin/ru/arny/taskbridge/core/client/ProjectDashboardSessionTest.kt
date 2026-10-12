package ru.arny.taskbridge.core.client

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import ru.arny.taskbridge.core.api.SimpleConnection
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.client.sessions.SessionList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * MR-01: the dashboard state. The screen reads it from [SessionList] — the same
 * poll as the session list — so what matters here is that the overview arrives,
 * that pinning sends only what changed, and that the state shows the server's
 * answer rather than a guess of ours.
 */
class ProjectDashboardSessionTest {
    private var overviewBody = """
        {"projects":[
          {"id":"taskbridge","name":"TaskBridge","path":"G:/p","sessions":41,"working":2,"needsAttention":1,
           "pinned":false,"archived":false,"lastActivityAt":"2026-10-11T07:20:00.000Z"},
          {"id":"old","name":"Старый","sessions":0,"archived":true}
        ],"unassignedSessions":3,
        "totals":{"projects":2,"pinned":0,"archived":1,"sessions":41,"working":2,"needsAttention":1}}
    """.trimIndent()

    private val patches = mutableListOf<String>()

    private fun api() = TaskBridgeApi(
        HttpClient(
            MockEngine { request ->
                val json = headersOf(HttpHeaders.ContentType, "application/json")
                when {
                    request.url.encodedPath == "/api/projects/overview" -> respond(overviewBody, HttpStatusCode.OK, json)
                    request.url.encodedPath.endsWith("/preferences") -> {
                        patches += (request.body as? TextContent)?.text.orEmpty()
                        // The server merges and answers with the whole state.
                        respond("""{"pinned":true,"archived":false,"updatedAt":"2026-10-11T07:30:00.000Z"}""", HttpStatusCode.OK, json)
                    }
                    request.url.encodedPath == "/api/tasks" -> respond("[]", HttpStatusCode.OK, json)
                    request.url.encodedPath == "/api/projects" -> respond("[]", HttpStatusCode.OK, json)
                    else -> respond("""{"version":1}""", HttpStatusCode.OK, json)
                }
            },
        ),
        SimpleConnection("http://pc:8787", clientId = "android-test"),
    )

    private fun sessions(scope: CoroutineScope) =
        SessionList(api(), scope, clockMillis = { 0 }, activeIntervalMillis = 20, idleIntervalMillis = 20)

    @Test
    fun theOverviewArrivesWithTheSessionList() = runBlocking<Unit> {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val list = sessions(scope)
            list.start()
            withTimeout(5_000) { while (list.state.value.overview == null) delay(10) }
            val state = list.state.value
            val projects = state.dashboardProjects
            assertEquals(listOf("taskbridge", "old"), projects.map { it.id })
            assertEquals(41, projects.first().sessions)
            assertEquals(2, projects.first().working)
            assertEquals(1, projects.first().needsAttention)
            assertTrue(projects.last().archived)
            assertEquals(3, state.overview!!.unassignedSessions, "sessions of a removed project are reported")
            assertEquals(41, state.overview!!.totals.sessions)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun pinningSendsOnlyTheChangedFlagAndShowsTheServersAnswer() = runBlocking<Unit> {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val list = sessions(scope)
            list.start()
            withTimeout(5_000) { while (list.state.value.overview == null) delay(10) }

            val result = list.setProjectPreferences("taskbridge", pinned = true)
            assertTrue(result.isSuccess, "${result.exceptionOrNull()}")
            assertEquals(listOf("""{"pinned":true}"""), patches, "archived must not be sent: the server keeps its value")

            val project = list.state.value.dashboardProjects.single { it.id == "taskbridge" }
            assertTrue(project.pinned, "the state shows what the server answered")
            // The other project is untouched by someone else's pin.
            assertEquals(true, list.state.value.dashboardProjects.single { it.id == "old" }.archived)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun aDashboardThatCannotBeReadLeavesTheListUsable() = runBlocking<Unit> {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val api = TaskBridgeApi(
                HttpClient(
                    MockEngine { request ->
                        val json = headersOf(HttpHeaders.ContentType, "application/json")
                        when (request.url.encodedPath) {
                            "/api/projects/overview" -> respond("""{"error":"boom","code":"INTERNAL"}""", HttpStatusCode.InternalServerError, json)
                            "/api/tasks" -> respond("""[{"id":"t1","status":"SUCCEEDED"}]""", HttpStatusCode.OK, json)
                            "/api/projects" -> respond("[]", HttpStatusCode.OK, json)
                            else -> respond("""{"version":1}""", HttpStatusCode.OK, json)
                        }
                    },
                ),
                SimpleConnection("http://pc:8787"),
            )
            val list = SessionList(api, scope, clockMillis = { 0 }, activeIntervalMillis = 20, idleIntervalMillis = 20)
            list.start()
            withTimeout(5_000) { while (list.state.value.error == null) delay(10) }
            assertEquals(null, list.state.value.overview, "no dashboard without an answer")
        } finally {
            scope.cancel()
        }
    }
}
