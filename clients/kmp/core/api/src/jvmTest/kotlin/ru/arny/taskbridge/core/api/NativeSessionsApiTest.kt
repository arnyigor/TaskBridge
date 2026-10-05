package ru.arny.taskbridge.core.api

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Импорт сессий Pi (паритет с вебом, раздел 2.11 плана): список групп, предпросмотр
 * и импорт. Проверяем и разбор ответов, и то, что уходит на сервер: ключ сессии —
 * непрозрачный sha256, путь клиент не присылает, а `take-over` обязан нести
 * `confirmedClosed` (без него сервер откажет).
 */
class NativeSessionsApiTest {
    private var lastRequest: HttpRequestData? = null
    private var body: String? = null

    private fun api(handler: (HttpRequestData) -> Pair<HttpStatusCode, String>) = TaskBridgeApi(
        HttpClient(MockEngine { request ->
            lastRequest = request
            body = (request.body as? TextContent)?.text
            val (status, text) = handler(request)
            respond(text, status, headersOf(HttpHeaders.ContentType, "application/json"))
        }),
        SimpleConnection("http://pc:8787"),
    )

    @Test
    fun sessionsAreGroupedByProjectWithImportMarkers() = runBlocking {
        val client = api {
            HttpStatusCode.OK to """
                [
                  {"id":"taskbridge","name":"TaskBridge","path":"G:/work/tb","sessions":[
                     {"key":"${"a".repeat(64)}","id":"s1","name":"Правим импорт","mtime":"2026-10-05T09:00:00.000Z",
                      "preview":"добавить импорт в KMP","existingTaskId":null},
                     {"key":"${"b".repeat(64)}","name":"старая","preview":"давно","existingTaskId":"4f3d2c1b0a98"}
                  ],"suggestion":{"key":"${"a".repeat(64)}","name":"Правим импорт","preview":"добавить импорт в KMP"}}
                ]
            """.trimIndent()
        }
        val groups = client.nativeSessions()
        assertEquals(1, groups.size)
        assertEquals("TaskBridge", groups[0].displayName)
        assertEquals(2, groups[0].sessions.size)
        assertEquals("Правим импорт", groups[0].sessions[0].displayName)
        assertEquals(null, groups[0].sessions[0].existingTaskId)
        assertEquals("4f3d2c1b0a98", groups[0].sessions[1].existingTaskId)
        assertEquals("a".repeat(64), groups[0].suggestion?.key)
        assertEquals("/api/native-sessions", lastRequest?.url?.encodedPath)
    }

    @Test
    fun previewAsksByProjectAndOpaqueKey() = runBlocking {
        val client = api {
            HttpStatusCode.OK to """
                {"projectId":"taskbridge","key":"${"c".repeat(64)}","name":"Правим импорт","entryCount":41,
                 "messageCount":12,"model":{"provider":"wormsoft","id":"glm-5.3-flash"},"thinkingLevel":"low",
                 "tokens":18432,"lastUser":"добавь импорт","lastAssistant":"сделано","existingTaskId":null}
            """.trimIndent()
        }
        val preview = client.nativeSessionPreview("taskbridge", "c".repeat(64))
        assertEquals(12, preview.messageCount)
        assertEquals("wormsoft", preview.model?.provider)
        assertEquals("glm-5.3-flash", preview.model?.id)
        assertEquals(18432L, preview.tokens)
        assertEquals("/api/native-sessions/preview", lastRequest?.url?.encodedPath)
        assertEquals("taskbridge", lastRequest?.url?.parameters?.get("projectId"))
        assertEquals("c".repeat(64), lastRequest?.url?.parameters?.get("key"))
    }

    @Test
    fun cloneImportPostsTheProjectKeyAndMode() = runBlocking {
        val client = api {
            HttpStatusCode.Created to """{"id":"7d1c9a0b4e21","title":"Правим импорт","prompt":"добавь импорт"}"""
        }
        val task = client.importNativeSession("taskbridge", "d".repeat(64))
        assertEquals("7d1c9a0b4e21", task.id)
        assertEquals(HttpMethod.Post, lastRequest?.method)
        assertEquals("/api/tasks/from-session", lastRequest?.url?.encodedPath)
        assertTrue(body.orEmpty().contains("\"mode\":\"clone\""), body.orEmpty())
        assertTrue(body.orEmpty().contains("\"projectId\":\"taskbridge\""), body.orEmpty())
        assertTrue(body.orEmpty().contains("\"confirmedClosed\":false"), body.orEmpty())
    }

    @Test
    fun takingOverTheOriginalCarriesTheConfirmation() = runBlocking {
        val client = api { HttpStatusCode.Created to """{"id":"7d1c9a0b4e22"}""" }
        client.importNativeSession("taskbridge", "e".repeat(64), NativeImportMode.TakeOver, confirmedClosed = true)
        assertTrue(body.orEmpty().contains("\"mode\":\"take-over\""), body.orEmpty())
        assertTrue(body.orEmpty().contains("\"confirmedClosed\":true"), body.orEmpty())
    }

    /** Ошибка сервера («сессия не найдена») доходит до UI как ApiException, а не как сырой сбой. */
    @Test
    fun serverRefusalBecomesAnApiError() = runBlocking {
        val client = api { HttpStatusCode.BadRequest to """{"error":{"code":"NOT_FOUND","message":"Сессия не найдена"}}""" }
        val failure = runCatching { client.importNativeSession("taskbridge", "f".repeat(64)) }.exceptionOrNull()
        assertTrue(failure is ApiException, "ожидали ApiException, получили $failure")
    }
}
