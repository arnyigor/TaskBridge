package ru.arny.taskbridge.ui.sessions

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.unit.dp
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import java.util.concurrent.ConcurrentHashMap
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.client.settings.KeyValueStore
import ru.arny.taskbridge.core.client.settings.SecretStore
import ru.arny.taskbridge.platform.DesktopPlatformServices
import ru.arny.taskbridge.platform.PlatformServices

/**
 * P0 Production/Test Isolation (инцидент 2026-11-20): клиент подключился к
 * чужому экземпляру на боевом адресе и объявил все сессии удалёнными.
 * Пустой список при чужом storeId обязан показывать предупреждение, а не
 * «Пока ни одной сессии».
 */
@OptIn(ExperimentalTestApi::class)
class SessionsStoreMismatchTest {

    private val foreignStoreId = "foreign-store-0000"

    @Test
    fun anEmptyListUnderAForeignStoreIdShowsTheMismatchInsteadOfTheEmptyState() = runComposeUiTest {
        val store = MemorySettings().apply { put("storeId", "production-store-1111") }
        var infoCalls = 0
        val engine = MockEngine { request ->
            val path = request.url.encodedPath
            val body = when {
                path.endsWith("/api/info") -> {
                    infoCalls++
                    """{"name":"TaskBridge","storeId":"$foreignStoreId","apiVersion":1,"addresses":[]}"""
                }
                path.endsWith("/api/tasks") -> "[]"
                path.endsWith("/api/projects/overview") -> """{"projects":[],"unassignedSessions":0,"totals":{}}"""
                path.endsWith("/api/projects") -> "[]"
                else -> "{}"
            }
            respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        val platform = object : PlatformServices by DesktopPlatformServices(store = store) {
            override fun httpClient(baseUrl: String?): HttpClient = HttpClient(engine)
        }
        val graph = AppGraph(platform)
        val connection = graph.connect("http://pc:8787")

        setContent {
            MaterialTheme {
                Box(Modifier.size(420.dp, 800.dp)) {
                    SessionsScreen(graph = graph, connection = connection, selectedTaskId = null, onOpen = {}, onDraft = {}, onSettings = {})
                }
            }
        }

        // Список загрузился и знает, что storeId чужой.
        waitUntil(timeoutMillis = 10_000) { infoCalls > 0 }
        println("DBG info=" + connection.sessions.state.value.info?.storeId + " known=" + store.get("storeId") + " mismatch=" + connection.storeMismatch.value + " err=" + connection.sessions.state.value.error)
        waitUntil(timeoutMillis = 10_000) { connection.storeMismatch.value }
        assertTrue(connection.storeMismatch.value, "чужой storeId обнаружен")
        onAllNodesWithText("Подключён другой экземпляр TaskBridge")[0].assertIsDisplayed()
        onNodeWithText("Пока ни одной сессии").assertDoesNotExist()
        // Кэш-настройка не подменена чужим storeId.
        assertEquals("production-store-1111", store.get("storeId"))
    }

    @Test
    fun theSameStoreIdKeepsTheCachedListAndDoesNotWarn() = runComposeUiTest {
        val knownStore = "production-store-1111"
        val store = MemorySettings().apply { put("storeId", knownStore) }
        var infoCalls = 0
        val engine = MockEngine { request ->
            val path = request.url.encodedPath
            val body = when {
                path.endsWith("/api/info") -> {
                    infoCalls++
                    """{"name":"TaskBridge","storeId":"$knownStore","apiVersion":1,"addresses":[]}"""
                }
                path.endsWith("/api/tasks") ->
                    """[{"id":"t1","title":"Kept session","projectId":"fixture","status":"SUCCEEDED","createdAt":"2026-11-01T00:00:00Z","updatedAt":"2026-11-01T00:00:00Z"}]"""
                path.endsWith("/api/projects/overview") -> """{"projects":[],"unassignedSessions":1,"totals":{}}"""
                path.endsWith("/api/projects") -> "[]"
                else -> "{}"
            }
            respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        val platform = object : PlatformServices by DesktopPlatformServices(store = store) {
            override fun httpClient(baseUrl: String?): HttpClient = HttpClient(engine)
        }
        val graph = AppGraph(platform)
        val connection = graph.connect("http://pc:8787")

        setContent {
            MaterialTheme {
                Box(Modifier.size(420.dp, 800.dp)) {
                    SessionsScreen(graph = graph, connection = connection, selectedTaskId = null, onOpen = {}, onDraft = {}, onSettings = {})
                }
            }
        }

        waitUntil(timeoutMillis = 10_000) { infoCalls > 0 && connection.sessions.state.value.tasks.isNotEmpty() }
        assertFalse(connection.storeMismatch.value, "the same store must not be treated as a foreign instance")
        assertEquals(knownStore, store.get("storeId"))
        assertTrue(connection.sessions.state.value.tasks.any { it.id == "t1" }, "cached session disappeared under the same storeId")
        onNodeWithText("Подключён другой экземпляр TaskBridge").assertDoesNotExist()
    }
}

private class MemorySettings : KeyValueStore, SecretStore {
    private val values = ConcurrentHashMap<String, String>()
    override fun get(key: String): String? = values[key]
    override fun put(key: String, value: String?) {
        if (value == null) values.remove(key) else values[key] = value
    }
}
