package ru.arny.taskbridge.core.api

import io.ktor.client.HttpClient
import io.ktor.client.request.forms.formData
import io.ktor.client.request.forms.submitFormWithBinaryData
import io.ktor.client.request.header
import io.ktor.client.request.prepareRequest
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.request.url
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsBytes
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.content.TextContent
import io.ktor.http.encodeURLParameter
import io.ktor.http.encodeURLPathPart
import io.ktor.http.isSuccess
import io.ktor.utils.io.readUTF8Line
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Where the daemon is and how this device authenticates to it. */
interface Connection {
    /** e.g. http://192.168.1.10:8787, without a trailing slash. */
    val baseUrl: String

    /** The `taskbridge_session` cookie value after pairing, or null. */
    var sessionCookie: String?

    /** A stable id of this installation, sent with every command. */
    val clientId: String
}

class SimpleConnection(
    override val baseUrl: String,
    override var sessionCookie: String? = null,
    override val clientId: String = "client",
) : Connection

/** A file picked on the device, read into memory (limits come from /api/info). */
class UploadFile(val name: String, val mimeType: String?, val bytes: ByteArray)

/** One item of a live session stream. */
sealed interface StreamItem {
    data class Event(val event: TaskEvent) : StreamItem

    /** The server asked for this reconnect delay (`retry:`). */
    data class Retry(val millis: Long) : StreamItem
}

/**
 * The daemon's HTTP API. Every call either returns the decoded body or throws
 * [ApiException]; transport failures become [ApiError.Unreachable]. The class
 * holds no state besides [connection], so one instance serves the whole app.
 */
class TaskBridgeApi(
    private val http: HttpClient,
    val connection: Connection,
) {
    private val base get() = connection.baseUrl.trimEnd('/')

    // --- host and auth -------------------------------------------------------

    suspend fun health(): Boolean = runCatching { send(HttpMethod.Get, "/api/health").status.isSuccess() }.getOrDefault(false)

    suspend fun info(): ApiInfo = get("/api/info", ApiInfo.serializer())

    suspend fun auth(): AuthStatus = get("/api/auth", AuthStatus.serializer())

    /** Restarts the whole TaskBridge process (202 at once, the relaunch is detached); running sessions are cut. */
    suspend fun restartServer() {
        send(HttpMethod.Post, "/api/server/restart", buildJsonObject { put("confirm", true) })
    }

    /**
     * Exchanges the pairing code shown on the PC for a session cookie and keeps
     * it in [connection]. The cookie is signed by the server and valid for up to
     * 31 days; a 401 later means pairing again.
     */
    suspend fun pair(code: String) {
        val response = send(HttpMethod.Post, "/api/auth/pair", buildJsonObject { put("code", code.trim()) })
        val cookie = response.headers.getAll(HttpHeaders.SetCookie).orEmpty()
            .firstNotNullOfOrNull { parseSessionCookie(it) }
        if (cookie != null) connection.sessionCookie = cookie
    }

    // --- projects and models -------------------------------------------------

    suspend fun projects(): List<Project> = get("/api/projects", ListSerializer(Project.serializer()))

    suspend fun models(refresh: Boolean = false): ModelCatalog =
        get("/api/models" + if (refresh) "?refresh=1" else "", ModelCatalog.serializer())

    // --- sessions ------------------------------------------------------------

    suspend fun tasks(): List<Task> = get("/api/tasks", ListSerializer(Task.serializer()))

    suspend fun task(id: String): Task = get("/api/tasks/${id.path()}", Task.serializer())

    suspend fun createTask(request: CreateTaskRequest): Task =
        call(HttpMethod.Post, "/api/tasks", Task.serializer(), TaskBridgeJson.encodeToJsonElement(CreateTaskRequest.serializer(), request.withClient()))

    suspend fun rename(id: String, title: String): Task =
        call(HttpMethod.Patch, "/api/tasks/${id.path()}", Task.serializer(), buildJsonObject { put("title", title) })

    suspend fun delete(id: String) {
        send(HttpMethod.Delete, "/api/tasks/${id.path()}")
    }

    /** Events after [after], oldest first. `limit = 0` means "as many as the server allows". */
    suspend fun events(id: String, after: Long = 0, limit: Int = 0): List<TaskEvent> =
        get("/api/tasks/${id.path()}/events?after=$after&limit=$limit", ListSerializer(TaskEvent.serializer()))

    /** A turn-aligned page of the newest history, or of the history before [before]. */
    suspend fun eventWindow(id: String, tail: Int, before: Long? = null): EventWindow =
        get("/api/tasks/${id.path()}/events?tail=$tail" + (before?.let { "&before=$it" } ?: ""), EventWindow.serializer())

    suspend fun commandStatus(commandId: String): CommandStatus =
        get("/api/commands/${commandId.path()}", CommandStatus.serializer())

    // --- conversation --------------------------------------------------------

    suspend fun message(id: String, request: MessageRequest): Task =
        call(HttpMethod.Post, "/api/tasks/${id.path()}/message", Task.serializer(),
            TaskBridgeJson.encodeToJsonElement(MessageRequest.serializer(), request.copy(clientId = request.clientId ?: connection.clientId)))

    suspend fun cancel(id: String, commandId: String? = null): Task =
        call(HttpMethod.Post, "/api/tasks/${id.path()}/cancel", Task.serializer(), buildJsonObject {
            commandId?.let { put("commandId", it) }
            put("clientId", connection.clientId)
        })

    suspend fun sendPendingNow(id: String, pendingId: String?): Task =
        call(HttpMethod.Post, "/api/tasks/${id.path()}/pending/send", Task.serializer(), buildJsonObject { pendingId?.let { put("pendingId", it) } })

    suspend fun dropPending(id: String, pendingId: String?): Task =
        call(HttpMethod.Delete, "/api/tasks/${id.path()}/pending" + (pendingId?.let { "?pendingId=${it.encodeURLParameter()}" } ?: ""), Task.serializer())

    suspend fun compact(id: String) {
        send(HttpMethod.Post, "/api/tasks/${id.path()}/compact", buildJsonObject { })
    }

    suspend fun setModel(id: String, model: ModelRef): Task =
        call(HttpMethod.Post, "/api/tasks/${id.path()}/model", Task.serializer(), buildJsonObject {
            model.provider?.let { put("provider", it) }
            put("id", model.id.orEmpty())
        })

    suspend fun setThinking(id: String, level: String): Task =
        call(HttpMethod.Post, "/api/tasks/${id.path()}/thinking", Task.serializer(), buildJsonObject { put("level", level) })

    suspend fun setAutoCompaction(id: String, enabled: Boolean) {
        send(HttpMethod.Post, "/api/tasks/${id.path()}/auto-compaction", buildJsonObject { put("enabled", enabled) })
    }

    // --- history rewriting ---------------------------------------------------

    /** Correct a settled message in place; `branch` keeps the old answer as a variant. */
    suspend fun editTurn(id: String, turnId: String, text: String, branch: Boolean = false) {
        send(HttpMethod.Post, "/api/tasks/${id.path()}/turns/${turnId.path()}/edit", buildJsonObject {
            put("text", text)
            put("branch", branch)
        })
    }

    /** Drop a turn and everything after it. */
    suspend fun deleteTurn(id: String, turnId: String) {
        send(HttpMethod.Post, "/api/tasks/${id.path()}/turns/${turnId.path()}/delete", buildJsonObject { })
    }

    suspend fun regenerate(id: String, turnId: String?) {
        send(HttpMethod.Post, "/api/tasks/${id.path()}/regenerate", buildJsonObject { turnId?.let { put("turnId", it) } })
    }

    suspend fun continueTurn(id: String, turnId: String?) {
        send(HttpMethod.Post, "/api/tasks/${id.path()}/continue", buildJsonObject { turnId?.let { put("turnId", it) } })
    }

    suspend fun selectVariant(id: String, turnSeq: Long, variantId: String) {
        send(HttpMethod.Post, "/api/tasks/${id.path()}/variant", buildJsonObject {
            put("turnSeq", turnSeq)
            put("variantId", variantId)
        })
    }

    /** A new session with the conversation copied through [turnId]. */
    suspend fun fork(id: String, turnId: String): Task =
        call(HttpMethod.Post, "/api/tasks/${id.path()}/fork", Task.serializer(), buildJsonObject { put("turnId", turnId) })

    suspend fun clear(id: String) {
        send(HttpMethod.Post, "/api/tasks/${id.path()}/clear", buildJsonObject { put("confirm", true) })
    }

    // --- approvals, tools, files ---------------------------------------------

    suspend fun approvals(id: String): List<Approval> =
        get("/api/tasks/${id.path()}/approvals", ListSerializer(Approval.serializer()))

    /** [decision]: ALLOW_ONCE or DENY. A 404 means someone else already answered. */
    suspend fun answerApproval(id: String, approvalId: String, allow: Boolean) {
        send(HttpMethod.Post, "/api/tasks/${id.path()}/approvals/${approvalId.path()}", buildJsonObject {
            put("decision", if (allow) "ALLOW_ONCE" else "DENY")
        })
    }

    suspend fun toolOutput(id: String, toolCallId: String): ToolOutput =
        get("/api/tasks/${id.path()}/tools/${toolCallId.path()}/output", ToolOutput.serializer())

    /** Streams files to the machine; pass the token and ids with the message or new task. */
    suspend fun upload(files: List<UploadFile>): UploadResult {
        val response = guard {
            http.submitFormWithBinaryData(
                url = "$base/api/uploads",
                formData = formData {
                    for (file in files) {
                        append("files", file.bytes, Headers.build {
                            append(HttpHeaders.ContentType, file.mimeType ?: "application/octet-stream")
                            append(HttpHeaders.ContentDisposition, "filename=\"${file.name.replace("\\", "_").replace("\"", "'")}\"")
                        })
                    }
                },
            ) {
                authorize()
                // The server's CSRF guard for multipart (src/auth.mjs).
                header("x-taskbridge-upload", "1")
            }
        }
        return decode(response, UploadResult.serializer())
    }

    /** A URL the platform can download or open (attachments, workspace files). */
    fun fileUrl(id: String, fileId: String): String = "$base/api/tasks/${id.path()}/files/${fileId.path()}"

    fun workspaceFileUrl(id: String, path: String): String = "$base/api/tasks/${id.path()}/workspace-file?path=${path.encodeURLParameter()}"

    /**
     * The bytes behind [fileUrl] / [workspaceFileUrl], read with this client's
     * session: a browser handed the bare URL has no cookie and gets 401.
     */
    suspend fun download(url: String): ByteArray {
        val response = guard { http.request { url(url); authorize() } }
        if (!response.status.isSuccess()) throw ApiException(apiErrorOf(response.status.value, response.bodyAsText()))
        return response.bodyAsBytes()
    }

    /** Opens (or reveals in the file manager) a workspace file with its app on the PC; only a client on the PC itself may. */
    suspend fun openWorkspaceFile(id: String, path: String, reveal: Boolean) {
        send(HttpMethod.Post, "/api/tasks/${id.path()}/workspace-file/open?path=${path.encodeURLParameter()}", buildJsonObject {
            put("confirm", true)
            put("reveal", reveal)
        })
    }

    /** The same for an attachment or an output file. */
    suspend fun openFile(id: String, fileId: String, reveal: Boolean) {
        send(HttpMethod.Post, "/api/tasks/${id.path()}/files/${fileId.path()}/open", buildJsonObject {
            put("confirm", true)
            put("reveal", reveal)
        })
    }

    // --- live stream -----------------------------------------------------------

    /**
     * One live connection to a session: replays everything after [after], then
     * stays open. Completes when the server closes the stream; throws
     * [ApiException] on failure, including [ApiError.Unreachable] when nothing
     * (not even the 15 s heartbeat) arrives for [idleTimeoutMillis].
     * Reconnecting is the caller's job (see SessionStream).
     */
    fun stream(id: String, after: Long, idleTimeoutMillis: Long = 45_000): Flow<StreamItem> = flow {
        val parser = SseParser()
        var announcedRetry: Long? = null
        try {
            http.prepareRequest {
                method = HttpMethod.Get
                url("$base/api/tasks/${id.path()}/stream?after=$after")
                header(HttpHeaders.Accept, "text/event-stream")
                header("Last-Event-ID", after.toString())
                authorize()
            }.execute { response ->
                if (!response.status.isSuccess()) throw ApiException(apiErrorOf(response.status.value, response.bodyAsText()))
                val channel = response.bodyAsChannel()
                while (true) {
                    val line = try {
                        withTimeout(idleTimeoutMillis) { channel.readUTF8Line() }
                    } catch (timeout: TimeoutCancellationException) {
                        throw ApiException(ApiError.Unreachable("Поток молчит дольше ${idleTimeoutMillis / 1000} с"))
                    } ?: break
                    val message = parser.feed(line)
                    val retry = parser.retryMillis
                    if (retry != null && retry != announcedRetry) {
                        announcedRetry = retry
                        emit(StreamItem.Retry(retry))
                    }
                    if (message != null && message.event == null) {
                        val event = runCatching { TaskBridgeJson.decodeFromString(TaskEvent.serializer(), message.data) }.getOrNull()
                        if (event != null) emit(StreamItem.Event(event))
                    }
                }
            }
        } catch (error: ApiException) {
            throw error
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            throw ApiException(ApiError.Unreachable(error.message ?: "Соединение прервано", error))
        }
    }

    // --- plumbing ------------------------------------------------------------

    private suspend fun <T> get(path: String, serializer: KSerializer<T>): T = call(HttpMethod.Get, path, serializer)

    private suspend fun <T> call(method: HttpMethod, path: String, serializer: KSerializer<T>, body: kotlinx.serialization.json.JsonElement? = null): T =
        decode(send(method, path, body), serializer)

    private suspend fun send(method: HttpMethod, path: String, body: kotlinx.serialization.json.JsonElement? = null): HttpResponse {
        val response = guard {
            http.request {
                this.method = method
                url(base + path)
                authorize()
                if (body != null) setBody(TextContent(TaskBridgeJson.encodeToString(kotlinx.serialization.json.JsonElement.serializer(), body), ContentType.Application.Json))
            }
        }
        if (!response.status.isSuccess()) throw ApiException(apiErrorOf(response.status.value, response.bodyAsText()))
        return response
    }

    private suspend fun <T> decode(response: HttpResponse, serializer: KSerializer<T>): T {
        if (!response.status.isSuccess()) throw ApiException(apiErrorOf(response.status.value, response.bodyAsText()))
        val text = response.bodyAsText()
        return try {
            TaskBridgeJson.decodeFromString(serializer, text)
        } catch (error: Exception) {
            throw ApiException(ApiError.Other(response.status.value, "DECODE", "Неожиданный ответ сервера: ${error.message}"))
        }
    }

    private suspend fun guard(block: suspend () -> HttpResponse): HttpResponse = try {
        block()
    } catch (error: CancellationException) {
        throw error
    } catch (error: ApiException) {
        throw error
    } catch (error: Throwable) {
        throw ApiException(ApiError.Unreachable(error.message ?: "Сервер недоступен", error))
    }

    private fun io.ktor.client.request.HttpRequestBuilder.authorize() {
        connection.sessionCookie?.let { header(HttpHeaders.Cookie, "$SESSION_COOKIE=$it") }
    }

    private fun CreateTaskRequest.withClient() = copy(clientId = clientId ?: connection.clientId)

    private fun String.path() = encodeURLPathPart()

    companion object {
        const val SESSION_COOKIE = "taskbridge_session"

        /** The value of `taskbridge_session` from one Set-Cookie header, or null. */
        fun parseSessionCookie(setCookie: String): String? {
            val first = setCookie.substringBefore(';').trim()
            if (!first.startsWith("$SESSION_COOKIE=")) return null
            return first.substringAfter('=').takeIf { it.isNotEmpty() }
        }
    }
}

internal fun jsonString(value: String) = JsonPrimitive(value)

internal fun emptyJson() = JsonObject(emptyMap())
