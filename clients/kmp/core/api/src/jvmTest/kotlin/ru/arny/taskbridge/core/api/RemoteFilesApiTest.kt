package ru.arny.taskbridge.core.api

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import kotlin.test.*

class RemoteFilesApiTest {
    @Test
    fun browseAndPreviewEncodeVirtualPathsWithoutInterpretingWindowsPaths() = runBlocking {
        val requests = mutableListOf<HttpRequestData>()
        val api = TaskBridgeApi(HttpClient(MockEngine { request ->
            requests += request
            val json = if (request.url.encodedPath.endsWith("preview")) """{"name":"a.txt","mimeType":"text/plain","text":"sample"}"""
                else """{"rootId":"r","path":"folder/a & b","entries":[],"nextCursor":"100"}"""
            respond(json, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }), SimpleConnection("http://pc:8787"))
        assertEquals("100", api.remoteBrowse("p 1", "r+1", "folder/a & b", "20").nextCursor)
        assertEquals("p 1", requests[0].url.pathSegments[3])
        assertEquals("r+1", requests[0].url.parameters["rootId"])
        assertEquals("folder/a & b", requests[0].url.parameters["path"])
        assertEquals("20", requests[0].url.parameters["cursor"])
        assertEquals("sample", api.remotePreview("p 1", "r", "folder/a.txt").text)
        assertEquals("folder/a.txt", requests[1].url.parameters["path"])
    }

    @Test
    fun requestAndLocalDecisionCarrySeparatePermissionsRevisionAndCommandIdentity() = runBlocking {
        val requests = mutableListOf<HttpRequestData>()
        val api = TaskBridgeApi(HttpClient(MockEngine { request ->
            requests += request
            respond("""{"id":"q","projectId":"p","status":"PENDING","requestedPath":null}""", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }), SimpleConnection("http://pc:8787"))
        api.requestExternalRead("p", "Downloads", listOf("browse", "preview"), 7, "command-request")
        api.decideExternalRead("p", "q", true, "D:\\Assets", 7, "command-decision")
        val first = TaskBridgeJson.parseToJsonElement((requests[0].body as TextContent).text).jsonObject
        assertEquals(7, first["expectedRevision"]!!.jsonPrimitive.int)
        assertEquals(listOf("browse", "preview"), first["permissions"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertFalse(first["permissions"].toString().contains("agent-read"))
        val decision = TaskBridgeJson.parseToJsonElement((requests[1].body as TextContent).text).jsonObject
        assertEquals("APPROVED", decision["decision"]!!.jsonPrimitive.content)
        assertEquals("command-decision", decision["commandId"]!!.jsonPrimitive.content)
        assertEquals("/api/projects/p/external-read/requests/q/decision", requests[1].url.encodedPath)
    }

    @Test
    fun snapshotPreparationIsNotAnUploadOrADownloadAndRevocationHasItsOwnRoute() = runBlocking {
        val requests = mutableListOf<HttpRequestData>()
        val api = TaskBridgeApi(HttpClient(MockEngine { request ->
            requests += request
            respond(if (request.url.encodedPath.endsWith("revoke")) """{"revision":4,"roots":[],"requests":[]}"""
                else """{"token":"snapshot-token","files":[{"id":"file-id","name":"a.txt"}]}""", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }), SimpleConnection("http://pc:8787"))
        val prepared = api.prepareRemoteAttachment("chat", "root", "a.txt", 3, "snapshot-command")
        assertEquals("snapshot-token", prepared.token)
        assertEquals("file-id", prepared.files.single().id)
        assertEquals("/api/tasks/chat/remote-files/prepare-attachment", requests[0].url.encodedPath)
        val body = (requests[0].body as TextContent).text
        assertFalse(body.contains("base64")); assertFalse(body.contains("mimeType"))
        assertEquals(4L, api.revokeExternalRead("p", "root", 3, "revoke-command").revision)
        assertEquals("/api/projects/p/external-read/roots/root/revoke", requests[1].url.encodedPath)
    }
}
