package ru.arny.taskbridge.core.client

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
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

class SessionListDeleteTest {

    /** A daemon whose list still names "a" (its delete is slow) and whose DELETE says "not found". */
    private fun api(listed: () -> List<String>) = TaskBridgeApi(
        HttpClient(MockEngine { request ->
            val json = headersOf(HttpHeaders.ContentType, "application/json")
            when {
                request.method == HttpMethod.Delete -> respond("""{"error":"Task not found","code":"NOT_FOUND"}""", HttpStatusCode.NotFound, json)
                request.url.encodedPath == "/api/tasks" -> respond(listed().joinToString(",", "[", "]") { """{"id":"$it","status":"SUCCEEDED"}""" }, HttpStatusCode.OK, json)
                request.url.encodedPath == "/api/projects" -> respond("[]", HttpStatusCode.OK, json)
                else -> respond("""{"version":1}""", HttpStatusCode.OK, json)
            }
        }),
        SimpleConnection("http://pc:8787"),
    )

    @Test
    fun aDeletedSessionStaysGoneWhileTheServerStillListsIt() = runBlocking {
        var listed = listOf("a", "b")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val sessions = SessionList(api { listed }, scope, clockMillis = { 0 }, activeIntervalMillis = 20, idleIntervalMillis = 20)
        sessions.start()
        withTimeout(5_000) { while (sessions.state.value.tasks.size != 2) delay(10) }

        assertTrue(sessions.delete("a").isSuccess, "404 on delete means already gone")
        delay(200) // several polls that still list "a"
        assertEquals(listOf("b"), sessions.state.value.tasks.map { it.id })

        // Once the server stops listing it, a session with the same id is no longer hidden.
        listed = listOf("b")
        delay(100)
        listed = listOf("a", "b")
        withTimeout(5_000) { while (sessions.state.value.tasks.size != 2) delay(10) }
        scope.cancel()
    }

    /**
     * Удаление пачки: сервер на каждую сессию гасит движок и чистит диск, поэтому запросы
     * обязаны идти параллельно, а не строгой очередью. Здесь сервер отвечает с задержкой —
     * если бы запросы шли по одному, время было бы суммой, а не максимумом.
     */
    @Test
    fun aBatchOfDeletesGoesInParallelAndReportsProgress() = runBlocking {
        val inFlight = java.util.concurrent.atomic.AtomicInteger()
        val peak = java.util.concurrent.atomic.AtomicInteger()
        val deleted = java.util.Collections.synchronizedList(mutableListOf<String>())
        val api = TaskBridgeApi(
            HttpClient(MockEngine { request ->
                val json = headersOf(HttpHeaders.ContentType, "application/json")
                when {
                    request.method == HttpMethod.Delete -> {
                        val now = inFlight.incrementAndGet()
                        peak.updateAndGet { old -> maxOf(old, now) }
                        kotlinx.coroutines.delay(120)
                        deleted += request.url.encodedPath.removePrefix("/api/tasks/")
                        inFlight.decrementAndGet()
                        respond("""{"ok":true}""", HttpStatusCode.OK, json)
                    }
                    request.url.encodedPath == "/api/tasks" -> respond("[]", HttpStatusCode.OK, json)
                    request.url.encodedPath == "/api/projects" -> respond("[]", HttpStatusCode.OK, json)
                    else -> respond("""{"version":1}""", HttpStatusCode.OK, json)
                }
            }),
            SimpleConnection("http://pc:8787"),
        )
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val sessions = SessionList(api, scope, clockMillis = { 0 })
        val ids = listOf("a", "b", "c", "d", "e", "f")
        val progress = mutableListOf<Int>()
        val failed = withTimeout(10_000) {
            sessions.deleteMany(ids) { _, done, failedNow -> progress += done + failedNow }
        }
        assertEquals(0, failed)
        assertEquals(ids.toSet(), deleted.toSet(), "до сервера обязаны дойти все выбранные сессии")
        assertTrue(peak.get() > 1, "удаления шли строгой очередью: пик одновременных = ${peak.get()}")
        assertEquals(ids.size, progress.size, "на каждую сессию — одно сообщение о прогрессе")
        assertEquals((1..ids.size).toList(), progress.sorted(), "прогресс не теряет шаги и не прыгает назад")
        scope.cancel()
    }
}
