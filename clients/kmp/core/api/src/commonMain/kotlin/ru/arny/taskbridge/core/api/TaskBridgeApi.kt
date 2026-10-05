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
import io.ktor.utils.io.readRemaining
import io.ktor.utils.io.readUTF8Line
import kotlinx.io.readByteArray
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.jsonObject

/** Where the daemon is and how this device authenticates to it. */
interface Connection {
    /** e.g. http://192.168.1.10:8787, without a trailing slash. */
    val baseUrl: String

    /** The `taskbridge_session` cookie value after pairing with a server older than device tokens, or null. */
    var sessionCookie: String?

    /** This device's token (server R1.2), sent as `Authorization: Bearer`; wins over [sessionCookie]. */
    var authToken: String?

    /** A stable id of this installation, sent with every command. */
    val clientId: String
}

class SimpleConnection(
    override val baseUrl: String,
    override var sessionCookie: String? = null,
    override val clientId: String = "client",
    override var authToken: String? = null,
) : Connection

/** A file picked on the device, read into memory (limits come from /api/info). */
class UploadFile(val name: String, val mimeType: String?, val bytes: ByteArray)

/** One item of a live session stream. */
sealed interface StreamItem {
    data class Event(val event: TaskEvent) : StreamItem
    data object Heartbeat : StreamItem

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

    /** Powers off the machine the server runs on; the cancel countdown lives in the UI, not on the server. */
    suspend fun shutdownComputer() {
        send(HttpMethod.Post, "/api/system/shutdown", buildJsonObject { put("confirm", true) })
    }

    /** Reboots the machine the server runs on; the cancel countdown lives in the UI, not on the server. */
    suspend fun rebootComputer() {
        send(HttpMethod.Post, "/api/system/reboot", buildJsonObject { put("confirm", true) })
    }

    // --- процессы машины (панель «Процессы») ---------------------------------

    /** Список процессов машины с сервером; кэш сервера 5 с, [fresh] — без него. */
    suspend fun processes(fresh: Boolean = false): List<ProcessEntry> =
        get("/api/processes" + if (fresh) "?fresh=1" else "", ProcessList.serializer()).processes

    /**
     * «Остановить»: серверу нужны pid И имя ровно из [processes] — имя защищает
     * от выстрела в переиспользованный pid. Системные процессы и дерево самого
     * TaskBridge сервер откажется убивать: [ApiException] с готовым сообщением.
     */
    suspend fun killProcess(pid: Long, name: String) {
        send(HttpMethod.Post, "/api/processes/kill", buildJsonObject {
            put("pid", pid)
            put("name", name)
        })
    }

    suspend fun gpuProcesses(): List<GpuProcessEntry> =
        get("/api/processes/gpu", GpuProcessList.serializer()).processes.orEmpty()

    suspend fun killProcessGroup(runtime: String) {
        send(HttpMethod.Post, "/api/processes/kill-group", buildJsonObject { put("runtime", runtime) })
    }

    /**
     * Exchanges the pairing code shown on the PC for this device's token and
     * keeps it in [connection]. The token lives until the PC revokes the device;
     * a 401 later means pairing again. A server older than device tokens answers
     * with a signed cookie only — kept as before.
     */
    suspend fun pair(code: String) {
        val kind = connection.clientId.substringBefore('-').takeIf { it == "android" || it == "desktop" } ?: "desktop"
        val response = send(HttpMethod.Post, "/api/auth/pair", buildJsonObject {
            put("code", code.trim())
            put("deviceName", connection.clientId)
            put("clientKind", kind)
        })
        val token = runCatching {
            TaskBridgeJson.parseToJsonElement(response.bodyAsText()).jsonObject["token"]?.jsonPrimitive?.contentOrNull
        }.getOrNull()
        if (token != null) {
            connection.authToken = token
            connection.sessionCookie = null
            return
        }
        val cookie = response.headers.getAll(HttpHeaders.SetCookie).orEmpty()
            .firstNotNullOfOrNull { parseSessionCookie(it) }
        if (cookie != null) connection.sessionCookie = cookie
    }

    // --- projects and models -------------------------------------------------

    suspend fun projects(): List<Project> = get("/api/projects", ListSerializer(Project.serializer()))

    suspend fun quickActions(taskId: String? = null): List<QuickAction> =
        get("/api/quick-actions" + (taskId?.let { "?taskId=${it.encodeURLParameter()}" } ?: ""), ListSerializer(QuickAction.serializer()))

    suspend fun projectFolders(path: String? = null): ProjectFolderListing =
        get("/api/project-browser" + (path?.let { "?path=${it.encodeURLParameter()}" } ?: ""), ProjectFolderListing.serializer())

    suspend fun registerProject(path: String, name: String): Project =
        call(HttpMethod.Post, "/api/project-browser/register", Project.serializer(), buildJsonObject {
            put("path", path)
            put("name", name)
        })

    /** Registers a folder chosen locally on the Pi server's computer. */
    suspend fun registerLocalProject(path: String): Project =
        call(HttpMethod.Post, "/api/projects/local-register", Project.serializer(), buildJsonObject { put("path", path) })

    suspend fun models(refresh: Boolean = false): ModelCatalog =
        get("/api/models" + if (refresh) "?refresh=1" else "", ModelCatalog.serializer())

    // --- локальные модели (роутер llama.cpp + внешние серверы вроде Strata) ---

    suspend fun local(): LocalRuntimeInfo = get("/api/local", LocalRuntimeInfo.serializer())

    /**
     * Кнопка «Обновить»: без 5-секундного кэша — по ней видно то, что изменилось на
     * диске (удалённые веса) или в конфигах, не дожидаясь следующего опроса.
     */
    suspend fun local(fresh: Boolean = false): LocalRuntimeInfo =
        get("/api/local" + if (fresh) "?fresh=1" else "", LocalRuntimeInfo.serializer())

    /**
     * «Загрузить»: для внешнего сервера (Strata) это запуск его процесса, а не
     * /models/load роутера — решает сервер TaskBridge. Ждёт готовности (до
     * loadTimeoutMs, для Strata это минуты), поэтому в UI кнопка висит в «…».
     */
    suspend fun loadLocalModel(id: String): LocalRuntimeInfo =
        call(HttpMethod.Post, "/api/local/load", LocalRuntimeInfo.serializer(), buildJsonObject { put("model", id) })

    /** «Выгрузить»: для Strata — остановка процесса сервера. */
    suspend fun unloadLocalModel(id: String): LocalRuntimeInfo =
        call(HttpMethod.Post, "/api/local/unload", LocalRuntimeInfo.serializer(), buildJsonObject { put("model", id) })

    /**
     * «Размер контекста» локальной модели. Контекст — параметр ЗАГРУЗКИ, поэтому
     * сервер пишет `--max-context` в конфиг внешнего сервера (Strata), а не в
     * сессию; новое значение подхватывается при следующей загрузке — об этом
     * говорит [LocalContextChange.restartRequired].
     *
     * У пресетов роутера llama.cpp контекст задаёт `ctx-size` в `models.ini`:
     * сервер отвечает `LOCAL_CONTEXT_UNSUPPORTED` (HTTP 400), а не молча ничего не
     * делает — поэтому в UI кнопка есть только у [LocalModelEntry.contextEditable].
     */
    suspend fun setLocalContext(id: String, context: Long): LocalContextChange =
        call(HttpMethod.Post, "/api/local/context", LocalContextChange.serializer(), buildJsonObject {
            put("model", id)
            put("context", context)
        })

    /**
     * «Vision» пресета роутера llama.cpp: сервер правит секцию пресета в `models.ini` — выключение
     * комментирует строку `mmproj` (явный проектор сильнее `no-mmproj`, т.е. `--no-mmproj-auto`),
     * а включение раскомментирует её; llama.cpp читает файл при старте.
     * Кнопка есть только у [LocalModelEntry.visionEditable]; внешним серверам и
     * строкам из Pi сервер отвечает `LOCAL_VISION_UNSUPPORTED` (HTTP 400).
     */
    suspend fun setLocalVision(id: String, vision: Boolean): LocalVisionChange =
        call(HttpMethod.Post, "/api/local/vision", LocalVisionChange.serializer(), buildJsonObject {
            put("model", id)
            put("vision", vision)
        })

    /**
     * «Убрать из списка»: сервер удаляет запись из конфига, которым владеет, —
     * внешний сервер из своего config.json (`localRuntime.externalServers`) или
     * секцию пресета роутера из `models.ini`. У найденной автоматически строки
     * (`hideable`) удалять нечего: она только скрывается
     * (`localRuntime.externalHidden`) и возвращается через [unhideLocalModel].
     * Модель, её файлы, конфиг движка и запущенный процесс не трогаются — поэтому
     * ответ возвращает новое состояние списка, а не что-то про модель.
     */
    suspend fun forgetLocalModel(id: String): LocalRuntimeInfo =
        call(HttpMethod.Post, "/api/local/forget", LocalRuntimeInfo.serializer(), buildJsonObject { put("model", id) })

    /** Вернуть скрытую строку в список (она снова появляется в [LocalRuntimeInfo.models]). */
    suspend fun unhideLocalModel(id: String): LocalRuntimeInfo =
        call(HttpMethod.Post, "/api/local/unhide", LocalRuntimeInfo.serializer(), buildJsonObject { put("model", id) })

    // --- Hugging Face: библиотека локальных моделей ---

    suspend fun hfSearch(query: String): List<HfSearchResult> =
        get("/api/hf/search?q=" + query.encodeURLParameter(), ListSerializer(HfSearchResult.serializer()))

    /** Репозиторий, разобранный сервером на кванты/проекторы. */
    suspend fun hfRepo(repo: String, revision: String = "main"): HfRepoInfo =
        get("/api/hf/repo?repo=" + repo.encodeURLParameter() + "&revision=" + revision.encodeURLParameter(), HfRepoInfo.serializer())

    /**
     * Начать загрузку: сервер сам берёт размеры из дерева и добавляет
     * mmproj-проектор, если он есть в репозитории (vision). Ответ — созданное
     * задание (202); прогресс опрашивается через [hfDownloads].
     */
    suspend fun hfDownload(repo: String, revision: String, files: List<String>): HfDownloadJob =
        call(HttpMethod.Post, "/api/hf/download", HfDownloadJob.serializer(), buildJsonObject {
            put("repo", repo)
            put("revision", revision)
            put("files", kotlinx.serialization.json.buildJsonArray { files.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } })
        })

    suspend fun hfDownloads(): HfDownloads = get("/api/hf/downloads", HfDownloads.serializer())

    /** Убрать завершённые задания из списка (файлы моделей остаются в библиотеке). */
    suspend fun clearHfDownloads(): HfDownloadsClear =
        call(HttpMethod.Post, "/api/hf/downloads/clear", HfDownloadsClear.serializer(), buildJsonObject {})

    suspend fun hfCancelDownload(id: String): HfDownloadJob =
        call(HttpMethod.Post, "/api/hf/downloads/cancel", HfDownloadJob.serializer(), buildJsonObject { put("id", id) })

    /** Продолжить прерванное/неудавшееся: готовые файлы пропускаются по размеру. */
    suspend fun hfRetryDownload(id: String): HfDownloadJob =
        call(HttpMethod.Post, "/api/hf/downloads/retry", HfDownloadJob.serializer(), buildJsonObject { put("id", id) })

    suspend fun library(fresh: Boolean = false): LibraryStatus =
        get("/api/library" + if (fresh) "?fresh=1" else "", LibraryStatus.serializer())

    /**
     * «Прописать в Pi»: пресет модели из библиотеки в models.ini роутера.
     * Pi перечисляет модели роутера через своего провайдера; [LibraryRegistration]
     * говорит, нужен ли перезапуск роутера (models.ini читается при старте).
     */
    suspend fun registerLibraryModel(id: String, ctxSize: Long? = null): LibraryRegistration =
        call(HttpMethod.Post, "/api/library/register", LibraryRegistration.serializer(), buildJsonObject {
            put("id", id)
            ctxSize?.let { put("ctxSize", it) }
        })

    /**
     * «Запустить» модель из библиотеки: при необходимости сервер сам перезапустит
     * управляемый роутер (перечитать models.ini) и загрузит пресет. Ответ —
     * свежий localStatus.
     */
    suspend fun runLibraryModel(id: String): LocalRuntimeInfo =
        call(HttpMethod.Post, "/api/library/run", LocalRuntimeInfo.serializer(), buildJsonObject { put("id", id) })

    /**
     * Удалить скачанную модель: пресет из models.ini и её файлы; файлы, общие
     * с другими записями (vision-проектор соседнего кванта), остаются. Запущенную
     * модель сервер откажется удалять.
     */
    suspend fun deleteLibraryModel(id: String): LibraryDeletion =
        call(HttpMethod.Post, "/api/library/delete", LibraryDeletion.serializer(), buildJsonObject { put("id", id) })

    suspend fun refreshProvider(provider: String): Map<String, ProviderStatus> =
        call(HttpMethod.Post, "/api/providers/refresh", kotlinx.serialization.builtins.MapSerializer(String.serializer(), ProviderStatus.serializer()),
            buildJsonObject { put("provider", provider) })

    suspend fun mcp(): McpStatus = get("/api/mcp", McpStatus.serializer())

    suspend fun setMcpMode(mode: String): McpStatus =
        call(HttpMethod.Post, "/api/mcp/mode", McpStatus.serializer(), buildJsonObject { put("mode", mode) })

    suspend fun importMcp(): McpStatus =
        call(HttpMethod.Post, "/api/mcp/import", McpStatus.serializer(), buildJsonObject { })

    suspend fun setMcpServer(name: String, enabled: Boolean): McpStatus =
        call(HttpMethod.Post, "/api/mcp/servers", McpStatus.serializer(), buildJsonObject {
            put("name", name)
            put("enabled", enabled)
        })

    suspend fun setMcpTool(server: String, tool: String, enabled: Boolean): McpStatus =
        call(HttpMethod.Post, "/api/mcp/tools", McpStatus.serializer(), buildJsonObject {
            put("server", server)
            put("tool", tool)
            put("enabled", enabled)
        })

    suspend fun probeMcp(server: String? = null): McpStatus =
        call(HttpMethod.Post, "/api/mcp/health", McpStatus.serializer(), buildJsonObject { server?.let { put("server", it) } })

    suspend fun saveMcpServer(name: String, url: String?, command: String?, args: List<String>): McpStatus =
        call(HttpMethod.Post, "/api/mcp/definitions", McpStatus.serializer(), buildJsonObject {
            put("name", name)
            url?.takeIf { it.isNotBlank() }?.let { put("url", it) }
            command?.takeIf { it.isNotBlank() }?.let { put("command", it) }
            put("args", kotlinx.serialization.json.JsonArray(args.map(::JsonPrimitive)))
        })

    suspend fun removeMcpServer(name: String): McpStatus =
        call(HttpMethod.Post, "/api/mcp/definitions", McpStatus.serializer(), buildJsonObject { put("name", name); put("remove", true) })

    // --- sessions ------------------------------------------------------------

    suspend fun tasks(): List<Task> = get("/api/tasks", ListSerializer(Task.serializer()))

    /**
     * Pi-сессии на диске, сгруппированные по проектам — источник для импорта
     * (GET /api/native-sessions). Сессия адресуется непрозрачным [NativeSession.key].
     */
    suspend fun nativeSessions(): List<NativeSessionGroup> =
        get("/api/native-sessions", ListSerializer(NativeSessionGroup.serializer()))

    /** Сессии одного проекта — роут совместимости рядом с общим списком. */
    suspend fun nativeSessions(projectId: String): List<NativeSession> =
        get("/api/projects/${projectId.encodeURLPathPart()}/pi-sessions", ListSerializer(NativeSession.serializer()))

    /** Что внутри сессии: модель, число сообщений, последние реплики, импортирована ли уже. */
    suspend fun nativeSessionPreview(projectId: String, sessionKey: String): NativeSessionPreview =
        get(
            "/api/native-sessions/preview?projectId=${projectId.encodeURLParameter()}&key=${sessionKey.encodeURLParameter()}",
            NativeSessionPreview.serializer(),
        )

    /**
     * Импорт Pi-сессии как задачи. `take-over` забирает оригинальный файл, поэтому
     * сервер требует [confirmedClosed]: оператор подтверждает, что закрыл сессию в терминале.
     */
    suspend fun importNativeSession(
        projectId: String,
        sessionKey: String,
        mode: NativeImportMode = NativeImportMode.Clone,
        confirmedClosed: Boolean = false,
    ): Task = call(HttpMethod.Post, "/api/tasks/from-session", Task.serializer(), buildJsonObject {
        put("projectId", projectId)
        put("sessionKey", sessionKey)
        put("mode", mode.wire)
        put("confirmedClosed", confirmedClosed)
    })

    suspend fun task(id: String): Task = get("/api/tasks/${id.path()}", Task.serializer())

    /** Files and folders of the task workspace, relative paths — the source of @-completions. */
    suspend fun workspaceFiles(id: String): WorkspaceFileListing =
        get("/api/tasks/${id.path()}/workspace-files", WorkspaceFileListing.serializer())

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

    suspend fun cancel(id: String, commandId: String? = null, hard: Boolean = false): Task =
        call(HttpMethod.Post, "/api/tasks/${id.path()}/cancel", Task.serializer(), buildJsonObject {
            commandId?.let { put("commandId", it) }
            put("clientId", connection.clientId)
            if (hard) put("hard", true)
        })

    suspend fun sendPendingNow(id: String, pendingId: String?): Task =
        call(HttpMethod.Post, "/api/tasks/${id.path()}/pending/send", Task.serializer(), buildJsonObject { pendingId?.let { put("pendingId", it) } })

    suspend fun dropPending(id: String, pendingId: String?): Task =
        call(HttpMethod.Delete, "/api/tasks/${id.path()}/pending" + (pendingId?.let { "?pendingId=${it.encodeURLParameter()}" } ?: ""), Task.serializer())

    suspend fun compact(id: String) {
        send(HttpMethod.Post, "/api/tasks/${id.path()}/compact", buildJsonObject { })
    }

    suspend fun restartSession(id: String): Task =
        call(HttpMethod.Post, "/api/tasks/${id.path()}/session/restart", Task.serializer(), buildJsonObject { })

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

    fun artifactUrl(id: String, name: String): String = "$base/api/tasks/${id.path()}/artifacts/${name.path()}"

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

    /** The same for a task artifact. */
    suspend fun openArtifact(id: String, name: String, reveal: Boolean) {
        send(HttpMethod.Post, "/api/tasks/${id.path()}/artifacts/${name.path()}/open", buildJsonObject {
            put("confirm", true)
            put("reveal", reveal)
        })
    }

    /** The task's artifacts (tool output logs, diff patches), in the server's order. */
    suspend fun artifacts(id: String): List<String> =
        get("/api/tasks/${id.path()}/artifacts", ListSerializer(String.serializer()))

    /** The raw Pi session state (GET /api/tasks/:id/state → { state: … }), unwrapped. */
    suspend fun state(id: String): JsonObject =
        get("/api/tasks/${id.path()}/state", JsonObject.serializer())["state"]?.jsonObject ?: JsonObject(emptyMap())

    /**
     * Откуда в модели берётся контекст и сколько он занимает (GET
     * /api/tasks/:id/context). Ничего не меняет: читает файлы источников и числа
     * запущенной сессии Pi.
     */
    suspend fun context(id: String): SessionContextReport =
        get("/api/tasks/${id.path()}/context", SessionContextReport.serializer())

    /**
     * Лимит контекста сессии в токенах, `null` — снять лимит. Возвращает свежий
     * отчёт, поэтому вызывающему не нужен второй запрос, чтобы его показать.
     */
    suspend fun setContextLimit(id: String, limit: Long?): SessionContextReport =
        call(HttpMethod.Post, "/api/tasks/${id.path()}/context", SessionContextReport.serializer(),
            buildJsonObject { put("limit", limit?.let { JsonPrimitive(it) } ?: JsonNull) })

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
                    if (line.startsWith(":")) emit(StreamItem.Heartbeat)
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
            withTimeout(if (method == HttpMethod.Get) 30_000L else 180_000L) { http.request {
                this.method = method
                url(base + path)
                authorize()
                if (body != null) setBody(TextContent(TaskBridgeJson.encodeToString(kotlinx.serialization.json.JsonElement.serializer(), body), ContentType.Application.Json))
            } }
        }
        if (!response.status.isSuccess()) throw ApiException(apiErrorOf(response.status.value, response.bodyAsText()))
        return response
    }

    private suspend fun <T> decode(response: HttpResponse, serializer: KSerializer<T>): T {
        if (!response.status.isSuccess()) throw ApiException(apiErrorOf(response.status.value, response.bodyAsText()))
        val text = readTextBody(response)
        return try {
            TaskBridgeJson.decodeFromString(serializer, text)
        } catch (error: Exception) {
            throw ApiException(ApiError.Other(response.status.value, "DECODE", "Неожиданный ответ сервера: ${error.message}"))
        }
    }

    /**
     * The body of every JSON answer is materialised as one String, so an unexpectedly
     * large one is a crash, not an error: on the phone a chat window full of image data
     * ended with OutOfMemoryError and Android force-finishing the activity (2026-09-28).
     * The limit is far above anything the server sends on purpose (tool output is capped
     * at 4 MB there) and only rejects what would otherwise take the process down.
     */
    private suspend fun readTextBody(response: HttpResponse): String {
        val bytes = response.bodyAsChannel().readRemaining(MAX_BODY_BYTES + 1).readByteArray()
        if (bytes.size > MAX_BODY_BYTES) {
            throw ApiException(ApiError.Other(response.status.value, "RESPONSE_TOO_LARGE", "Ответ сервера слишком большой (${bytes.size / 1_048_576} МБ) — откройте сессию заново."))
        }
        return bytes.decodeToString()
    }

    private suspend fun guard(block: suspend () -> HttpResponse): HttpResponse = try {
        block()
    } catch (error: TimeoutCancellationException) {
        throw ApiException(ApiError.Unreachable("Сервер не ответил вовремя. Исход команды уточняется по истории.", error))
    } catch (error: CancellationException) {
        throw error
    } catch (error: ApiException) {
        throw error
    } catch (error: Throwable) {
        throw ApiException(ApiError.Unreachable(error.message ?: "Сервер недоступен", error))
    }

    private fun io.ktor.client.request.HttpRequestBuilder.authorize() {
        val token = connection.authToken
        if (token != null) header(HttpHeaders.Authorization, "Bearer $token")
        else connection.sessionCookie?.let { header(HttpHeaders.Cookie, "$SESSION_COOKIE=$it") }
    }

    private fun CreateTaskRequest.withClient() = copy(clientId = clientId ?: connection.clientId)

    private fun String.path() = encodeURLPathPart()

    companion object {
        const val SESSION_COOKIE = "taskbridge_session"

        /** Ceiling for a JSON body read into one String (see [readTextBody]). */
        const val MAX_BODY_BYTES = 16L * 1024L * 1024L

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
