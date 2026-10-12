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
import ru.arny.taskbridge.core.client.projects.ProjectWorkspace
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ProjectWorkspaceTest {
    private val requests = mutableListOf<Pair<String, String>>()

    private fun api() = TaskBridgeApi(
        HttpClient(
            MockEngine { request ->
                requests += request.method.value to request.url.encodedPath + request.url.encodedQuery.let { if (it.isEmpty()) "" else "?$it" }
                val json = headersOf(HttpHeaders.ContentType, "application/json")
                when {
                    request.url.encodedPath == "/api/work-items" -> respond(
                        """{"items":[
                          {"id":"wi-open","projectId":"p1","title":"Open","status":"IN_PROGRESS","priority":1},
                          {"id":"wi-done","projectId":"p1","title":"Done","status":"DONE"}
                        ]}""", HttpStatusCode.OK, json,
                    )
                    request.url.encodedPath == "/api/recipes" -> respond(
                        """{"items":[{"id":"r1","projectId":"p1","name":"Audit","promptTemplate":"Check"}]}""",
                        HttpStatusCode.OK, json,
                    )
                    request.url.encodedPath == "/api/schedules" && request.method == HttpMethod.Get -> respond(
                        """{"items":[
                          {"id":"s1","recipeId":"r1","enabled":true,"spec":{"kind":"daily","at":"09:00"}},
                          {"id":"foreign","recipeId":"r2","enabled":true,"spec":{"kind":"daily","at":"10:00"}}
                        ]}""", HttpStatusCode.OK, json,
                    )
                    request.url.encodedPath == "/api/invocations" -> respond(
                        """{"items":[
                          {"id":"i1","recipeId":"r1","status":"SUCCEEDED","startedAt":"2026-10-11T09:00:00Z","sessionId":"old"},
                          {"id":"i2","recipeId":"r2","status":"FAILED","startedAt":"2026-10-11T10:00:00Z"}
                        ]}""", HttpStatusCode.OK, json,
                    )
                    request.url.encodedPath == "/api/schedules/s1/run" -> respond(
                        """{"id":"i-new","recipeId":"r1","scheduleId":"s1","status":"RUNNING","sessionId":"session-new"}""",
                        HttpStatusCode.OK, json,
                    )
                    request.url.encodedPath == "/api/schedules/s1" && request.method == HttpMethod.Patch -> {
                        assertEquals("""{"enabled":false}""", (request.body as TextContent).text)
                        respond("""{"id":"s1","recipeId":"r1","enabled":false,"spec":{"kind":"daily","at":"09:00"}}""", HttpStatusCode.OK, json)
                    }
                    else -> error("Unexpected request ${request.method.value} ${request.url}")
                }
            },
        ),
        SimpleConnection("http://pc:8787"),
    )

    @Test
    fun loadsAndJoinsOnlyTheSelectedProjectsRecurringWork() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val workspace = ProjectWorkspace(api(), "p1", scope)
            workspace.start()
            withTimeout(5_000) { while (workspace.state.value.loading) delay(10) }

            val state = workspace.state.value
            assertEquals(listOf("wi-open"), state.openWorkItems.map { it.id })
            assertEquals(listOf("r1"), state.recipes.map { it.id })
            assertEquals(listOf("s1"), state.schedules.map { it.id }, "another project's schedule is not shown")
            assertEquals(listOf("i1"), state.invocations.map { it.id }, "another project's invocation is not shown")
            assertEquals("i1", state.latestInvocation("r1")?.id)
            assertTrue(requests.any { it.second.contains("/api/work-items") && it.second.contains("projectId=p1") }, "project filter missing: $requests")
            assertTrue(requests.any { it.second.contains("/api/invocations") && it.second.contains("recipeId=r1") && it.second.contains("limit=1") }, "latest run is requested per recipe, not from a global window: $requests")
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun scheduledRunUsesTheInvocationPathAndPauseUsesAPartialPatch() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            val workspace = ProjectWorkspace(api(), "p1", scope)
            workspace.start()
            withTimeout(5_000) { while (workspace.state.value.loading) delay(10) }

            assertEquals("session-new", workspace.runNow("r1").getOrThrow())
            assertTrue(requests.any { it.first == "POST" && it.second == "/api/schedules/s1/run" })
            assertFalse(requests.any { it.second == "/api/recipes/r1/run" }, "a scheduled recipe must create a durable invocation")

            val paused = workspace.setScheduleEnabled("s1", false).getOrThrow()
            assertFalse(paused.enabled)
            assertFalse(workspace.state.value.schedules.single().enabled)
        } finally {
            scope.cancel()
        }
    }
}
