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
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
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
class UploadFile(
    val name: String,
    val mimeType: String?,
    val bytes: ByteArray,
    /** Local absolute path on desktop; null when the file came from a content URI. */
    val sourcePath: String? = null,
)

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

    /**
     * Жив ли сервер. Короткий таймаут нужен вызывающим, которые спрашивают это
     * на пути переподключения (двухуровневый health, план 4.2): проба не должна
     * задерживать следующую попытку потока.
     */
    suspend fun health(timeoutMs: Long = 30_000L): Boolean =
        runCatching { send(HttpMethod.Get, "/api/health", timeoutMs = timeoutMs).status.isSuccess() }.getOrDefault(false)

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
     * План очистки (PROC-04): сервер сам отбирает кандидатов по цели ram|gpu и
     * исключает защищённые. [pids] ограничивает план явным выбором — «Освободить
     * GPU» присылает только процессы, которые nvidia-smi видит держащими VRAM,
     * иначе GPU-цель предложила бы вообще все Node/Python/Java.
     * План живёт 60 с: показать его, закрыть и выполнить через час нельзя.
     */
    suspend fun cleanupPreview(objective: String = "gpu", pids: List<Long>? = null): CleanupPlan =
        call(HttpMethod.Post, "/api/system/cleanup/preview", CleanupPlan.serializer(), buildJsonObject {
            put("objective", objective)
            if (!pids.isNullOrEmpty()) {
                put("pids", kotlinx.serialization.json.JsonArray(pids.map { kotlinx.serialization.json.JsonPrimitive(it) }))
            }
        })

    /**
     * Выполнение подтверждённого плана; commandId делает повтор безопасным
     * (тот же commandId не убивает второй раз). Сервер отвечает 403 вне
     * компьютера сервера — массовая остановка только локально (PROC-07).
     */
    suspend fun cleanupExecute(planId: String, commandId: String): CleanupResult =
        call(HttpMethod.Post, "/api/system/cleanup/execute", CleanupResult.serializer(), buildJsonObject {
            put("planId", planId)
            put("commandId", commandId)
            put("confirm", true)
        })

    /** Агрегированные ресурсы машины (RAM ОС + GPU-агрегат nvidia-smi), см. PROC-01. */
    suspend fun systemResources(): ResourceSnapshot =
        get("/api/system/resources", ResourceSnapshot.serializer())

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

    // --- project dashboard (MR-01) ------------------------------------------

    /** Every registered project with its session counts and pinned/archived. */
    suspend fun projectOverview(): ProjectOverview =
        get("/api/projects/overview", ProjectOverview.serializer())

    /**
     * Инспектор памяти проекта (MR-10): что проект отдаёт агенту прямо сейчас.
     *
     * [query] == null — обзор (без списка записей), пустая строка — поиск: поле только
     * что очистили, и сервер отвечает первыми записями, а не другой формой ответа.
     * Инспектор только читает: `write` в ответе всегда `SAVE_DISABLED`.
     */
    suspend fun projectMemory(projectId: String, query: String? = null): ProjectMemoryOverview {
        val suffix = query?.let { "?q=${it.encodeURLParameter()}" } ?: ""
        return get("/api/projects/${projectId.encodeURLPathPart()}/memory$suffix", ProjectMemoryOverview.serializer())
    }

    /**
     * Sessions of one project, filtered and paged by the server: a phone must not
     * pull every conversation of a big project to show a list.
     */
    suspend fun projectSessions(
        projectId: String,
        query: String? = null,
        status: String? = null,
        sort: String? = null,
        limit: Int? = null,
        offset: Int? = null,
    ): ProjectSessionsPage {
        val params = listOfNotNull(
            query?.takeIf { it.isNotBlank() }?.let { "q=${it.encodeURLParameter()}" },
            status?.takeIf { it.isNotBlank() }?.let { "status=${it.encodeURLParameter()}" },
            sort?.takeIf { it.isNotBlank() }?.let { "sort=${it.encodeURLParameter()}" },
            limit?.let { "limit=$it" },
            offset?.let { "offset=$it" },
        ).joinToString("&")
        return get(
            "/api/projects/${projectId.encodeURLPathPart()}/sessions" + if (params.isEmpty()) "" else "?$params",
            ProjectSessionsPage.serializer(),
        )
    }

    // --- work items (MR-02) --------------------------------------------------

    /** Work items, newest first; [projectId] narrows to one project. */
    suspend fun workItems(projectId: String? = null, status: String? = null, includeClosed: Boolean = true): List<WorkItem> {
        val params = listOfNotNull(
            projectId?.takeIf { it.isNotBlank() }?.let { "projectId=${it.encodeURLParameter()}" },
            status?.takeIf { it.isNotBlank() }?.let { "status=${it.encodeURLParameter()}" },
            if (includeClosed) null else "includeClosed=0",
        ).joinToString("&")
        val body = get("/api/work-items" + if (params.isEmpty()) "" else "?$params", WorkItemList.serializer())
        return body.items
    }

    suspend fun workItem(id: String): WorkItem = get("/api/work-items/${id.encodeURLPathPart()}", WorkItem.serializer())

    suspend fun createWorkItem(request: WorkItemRequest): WorkItem =
        call(HttpMethod.Post, "/api/work-items", WorkItem.serializer(), request.toJson())

    /** A partial update: a field left null keeps its stored value on the server. */
    suspend fun updateWorkItem(id: String, request: WorkItemRequest): WorkItem =
        call(HttpMethod.Patch, "/api/work-items/${id.encodeURLPathPart()}", WorkItem.serializer(), request.toJson())

    suspend fun deleteWorkItem(id: String): WorkItem =
        call(HttpMethod.Delete, "/api/work-items/${id.encodeURLPathPart()}", WorkItemDeleted.serializer()).removed

    // --- run recipes (MR-05) -------------------------------------------------

    suspend fun recipes(projectId: String? = null): List<RunRecipe> {
        val query = projectId?.takeIf { it.isNotBlank() }?.let { "?projectId=${it.encodeURLParameter()}" } ?: ""
        return get("/api/recipes$query", RecipeList.serializer()).items
    }

    suspend fun recipe(id: String): RunRecipe = get("/api/recipes/${id.encodeURLPathPart()}", RunRecipe.serializer())

    suspend fun createRecipe(request: RecipeRequest): RunRecipe =
        call(HttpMethod.Post, "/api/recipes", RunRecipe.serializer(), RecipeJson.request(request))

    suspend fun updateRecipe(id: String, request: RecipeRequest): RunRecipe =
        call(HttpMethod.Patch, "/api/recipes/${id.encodeURLPathPart()}", RunRecipe.serializer(), RecipeJson.request(request))

    suspend fun deleteRecipe(id: String): RunRecipe =
        call(HttpMethod.Delete, "/api/recipes/${id.encodeURLPathPart()}", RecipeDeleted.serializer()).removed

    /**
     * Runs the recipe now. [parameters] are the values the operator chose; the ones
     * left out take their declared defaults on the server.
     */
    suspend fun runRecipe(id: String, parameters: Map<String, String> = emptyMap(), trigger: String? = null): RecipeRunResult =
        call(
            HttpMethod.Post,
            "/api/recipes/${id.encodeURLPathPart()}/run",
            RecipeRunResult.serializer(),
            buildJsonObject {
                if (parameters.isNotEmpty()) {
                    put("parameters", buildJsonObject { parameters.forEach { (key, value) -> put(key, value) } })
                }
                trigger?.let { put("trigger", it) }
            },
        )

    /**
     * Encodes a recipe request. Null fields are dropped instead of being sent as
     * `null`: on the wire an absent field means «keep the stored value», and only an
     * explicit null clears one.
     */
    private object RecipeJson {
        fun request(request: RecipeRequest): kotlinx.serialization.json.JsonObject {
            val element = TaskBridgeJson.encodeToJsonElement(RecipeRequest.serializer(), request)
            return kotlinx.serialization.json.JsonObject(
                (element as kotlinx.serialization.json.JsonObject).filterValues { it !is kotlinx.serialization.json.JsonNull },
            )
        }
    }

    // --- schedules and invocations (MR-06) ------------------------------------

    suspend fun schedules(recipeId: String? = null): List<Schedule> {
        val query = recipeId?.takeIf { it.isNotBlank() }?.let { "?recipeId=${it.encodeURLParameter()}" } ?: ""
        return get("/api/schedules$query", ScheduleList.serializer()).items
    }

    suspend fun schedule(id: String): Schedule = get("/api/schedules/${id.encodeURLPathPart()}", Schedule.serializer())

    suspend fun createSchedule(request: ScheduleRequest): Schedule =
        call(HttpMethod.Post, "/api/schedules", Schedule.serializer(), ScheduleJson.request(request))

    suspend fun updateSchedule(id: String, request: ScheduleRequest): Schedule =
        call(HttpMethod.Patch, "/api/schedules/${id.encodeURLPathPart()}", Schedule.serializer(), ScheduleJson.request(request))

    suspend fun deleteSchedule(id: String): Schedule =
        call(HttpMethod.Delete, "/api/schedules/${id.encodeURLPathPart()}", ScheduleDeleted.serializer()).removed

    /** Run it now: the same path a schedule takes, with the operator as the reason. */
    suspend fun runScheduleNow(id: String): Invocation =
        call(HttpMethod.Post, "/api/schedules/${id.encodeURLPathPart()}/run", Invocation.serializer(), buildJsonObject {})

    suspend fun invocations(
        recipeId: String? = null,
        scheduleId: String? = null,
        status: String? = null,
        limit: Int? = null,
    ): List<Invocation> {
        val params = listOfNotNull(
            recipeId?.takeIf { it.isNotBlank() }?.let { "recipeId=${it.encodeURLParameter()}" },
            scheduleId?.takeIf { it.isNotBlank() }?.let { "scheduleId=${it.encodeURLParameter()}" },
            status?.takeIf { it.isNotBlank() }?.let { "status=${it.encodeURLParameter()}" },
            limit?.let { "limit=$it" },
        ).joinToString("&")
        return get("/api/invocations" + if (params.isEmpty()) "" else "?$params", InvocationList.serializer()).items
    }

    suspend fun invocation(id: String): Invocation = get("/api/invocations/${id.encodeURLPathPart()}", Invocation.serializer())

    /** One tick of the machine's scheduler — diagnostics, and what the misfire policies are checked with. */
    suspend fun schedulerTick(now: String? = null): SchedulerTickResult =
        call(
            HttpMethod.Post, "/api/scheduler/tick", SchedulerTickResult.serializer(),
            buildJsonObject { now?.let { put("now", it) } },
        )

    /**
     * Encodes a schedule request: null fields are dropped, because on the wire an
     * absent field means «keep the stored value» and only an explicit one changes it
     * (a default-filled `spec` would silently rewrite the schedule).
     */
    private object ScheduleJson {
        fun request(request: ScheduleRequest): kotlinx.serialization.json.JsonObject {
            val element = TaskBridgeJson.encodeToJsonElement(ScheduleRequest.serializer(), request)
            val body = kotlinx.serialization.json.JsonObject(
                (element as kotlinx.serialization.json.JsonObject).filterValues { it !is kotlinx.serialization.json.JsonNull },
            )
            val spec = request.spec
            if (spec == null) return body
            // `kind` is written EXPLICITLY: it has a default value, and kotlinx omits a
            // field equal to its default, so `spec: {"at": "09:00"}` would reach the
            // server with no kind at all and be refused. Nulls inside the spec are
            // dropped for the same reason (absent = keep).
            val withSpec: Map<String, kotlinx.serialization.json.JsonElement> = body + (
                "spec" to buildJsonObject {
                    put("kind", spec.kind)
                    spec.at?.let { put("at", it) }
                    spec.weekday?.let { put("weekday", it) }
                    spec.everyMinutes?.let { put("everyMinutes", it) }
                }
                )
            return kotlinx.serialization.json.JsonObject(withSpec)
        }
    }

    /** The work item WITH its sessions: one call is what the screen needs (MR-03). */
    suspend fun workItemDetail(id: String): WorkItemDetail =
        get("/api/work-items/${id.encodeURLPathPart()}", WorkItemDetail.serializer())

    /** Sessions linked to a work item. */
    suspend fun workItemSessions(workItemId: String): List<WorkItemSession> =
        get("/api/work-items/${workItemId.encodeURLPathPart()}/sessions", WorkItemSessionList.serializer()).items

    /** Links a session to a work item; linking twice updates the relation. */
    suspend fun linkWorkItemSession(workItemId: String, sessionId: String, relation: String? = null): WorkItemSession =
        call(
            HttpMethod.Post,
            "/api/work-items/${workItemId.encodeURLPathPart()}/sessions",
            WorkItemSession.serializer(),
            buildJsonObject {
                put("sessionId", sessionId)
                relation?.let { put("relation", it) }
            },
        )

    /** Unlinks one session; the session itself is untouched. */
    suspend fun unlinkWorkItemSession(workItemId: String, sessionId: String): Boolean =
        call(
            HttpMethod.Delete,
            "/api/work-items/${workItemId.encodeURLPathPart()}/sessions/${sessionId.encodeURLPathPart()}",
            WorkItemUnlink.serializer(),
        ).removed

    /** The work items a session belongs to. */
    suspend fun workItemsOfSession(sessionId: String): List<WorkItemRef> =
        get("/api/tasks/${sessionId.encodeURLPathPart()}/work-items", WorkItemRefList.serializer()).items

    private fun WorkItemRequest.toJson(): kotlinx.serialization.json.JsonObject = buildJsonObject {
        projectId?.let { put("projectId", it) }
        title?.let { put("title", it) }
        // The server clears a nullable field only on an explicit null, and a null in
        // this request means «do not change it» — hence [WorkItemRequest.clearGoal].
        if (clearGoal) put("goal", kotlinx.serialization.json.JsonNull) else goal?.let { put("goal", it) }
        status?.let { put("status", it) }
        priority?.let { put("priority", it) }
        acceptanceCriteria?.let { list -> put("acceptanceCriteria", kotlinx.serialization.json.buildJsonArray { list.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }) }
        tags?.let { list -> put("tags", kotlinx.serialization.json.buildJsonArray { list.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }) }
    }

    /** Pin or archive a project; an omitted flag keeps its stored value. */
    suspend fun setProjectPreferences(projectId: String, pinned: Boolean? = null, archived: Boolean? = null): ProjectPreferences =
        call(
            HttpMethod.Patch,
            "/api/projects/${projectId.encodeURLPathPart()}/preferences",
            ProjectPreferences.serializer(),
            buildJsonObject {
                pinned?.let { put("pinned", it) }
                archived?.let { put("archived", it) }
            },
        )

    suspend fun models(refresh: Boolean = false): ModelCatalog =
        get("/api/models" + if (refresh) "?refresh=1" else "", ModelCatalog.serializer())

    /** Explicit probe: latency mode spends at most one token and is not model history. */
    suspend fun probeModel(provider: String, id: String, mode: String = "latency"): ModelProbeResult =
        call(
            HttpMethod.Post,
            "/api/models/probe",
            ModelProbeResult.serializer(),
            buildJsonObject {
                put("provider", provider)
                put("id", id)
                put("mode", mode)
            },
        )

    /** Регистрирует приёмник wake-канала своего push (адрес сервер видит из соединения). */
    suspend fun registerWakeChannel(port: Int): JsonObject? =
        call(
            HttpMethod.Post,
            "/api/clients/wake",
            JsonObject.serializer(),
            buildJsonObject { put("port", port) },
        )

    /**
     * Переход связи для серверной наблюдаемости (фаза 4): live / degraded / reconnecting.
     *
     * Отправляется только состояние, причина и номер попытки — ни промпта, ни
     * истории, ни состояния чата: это метрика, а не канал данных. Сбои отправки
     * глушит вызывающий: наблюдение не может мешать работе.
     */
    suspend fun reportLinkState(state: String, reason: String? = null, attempt: Int? = null): JsonObject? =
        call(
            HttpMethod.Post,
            "/api/clients/link",
            JsonObject.serializer(),
            buildJsonObject {
                put("state", state)
                put("clientId", connection.clientId)
                if (reason != null) put("reason", reason.take(200))
                if (attempt != null) put("attempt", attempt)
            },
        )

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

    // --- Провайдеры Pi: страница «Провайдеры» (то же, что веб-UI /providers) ---
    //
    // Маршруты /api/provider-profiles* сервер отдаёт только через localhost
    // (ORIGIN_FORBIDDEN): ключи живут в окружении процесса компьютера, и
    // настраивать адрес, куда ходит Pi, должен только его владелец.
    // /api/providers/check при этом доступен отовсюду — он read-only.

    /** Подключения из models.json + ревизия файла; каждая правка обязана прийти со своей ревизией. */
    suspend fun providerProfiles(): ProviderProfilesPage =
        get("/api/provider-profiles", ProviderProfilesPage.serializer())

    /** Создать или обновить управляемую запись `tb-*`. Вместо ключа — только имя переменной окружения. */
    suspend fun saveProviderProfile(
        revision: String,
        id: String,
        baseUrl: String,
        keyEnv: String,
        models: List<String>,
    ): ProviderProfilesPage =
        call(HttpMethod.Put, "/api/provider-profiles", ProviderProfilesPage.serializer(), buildJsonObject {
            put("revision", revision)
            put("id", id)
            put("baseUrl", baseUrl)
            put("keyEnv", keyEnv)
            put("models", kotlinx.serialization.json.JsonArray(models.map { JsonPrimitive(it) }))
        })

    /**
     * Убрать модели из записи провайдера. Правится ТОЛЬКО список моделей: адрес,
     * api и ключ чужой записи сервер не меняет; перед записью он снимает копию
     * models.json и сверяет ревизию.
     */
    suspend fun removeProviderModels(id: String, models: List<String>, revision: String): ProviderProfilesPage =
        call(HttpMethod.Post, "/api/provider-profiles/${id.encodeURLPathPart()}/models/remove", ProviderProfilesPage.serializer(), buildJsonObject {
            put("revision", revision)
            put("models", kotlinx.serialization.json.JsonArray(models.map { JsonPrimitive(it) }))
        })

    /** Удалить управляемую запись `tb-*` (копия models.json остаётся рядом). */
    suspend fun deleteProviderProfile(id: String, revision: String): ProviderProfilesPage =
        call(HttpMethod.Delete, "/api/provider-profiles/${id.encodeURLPathPart()}", ProviderProfilesPage.serializer(), buildJsonObject {
            put("revision", revision)
        })

    /**
     * Проверка соединения с провайдером: один `GET /models`, без генерации. Работает
     * и с `tb-*`, и с записями, которыми TaskBridge не владеет: адрес берётся из
     * каталога Pi, а не из запроса.
     */
    suspend fun checkProviderConnection(provider: String, id: String? = null): ProviderCheck =
        call(HttpMethod.Post, "/api/providers/check", ProviderCheck.serializer(), buildJsonObject {
            put("provider", provider)
            id?.let { put("id", it) }
        })

    /**
     * Проверка несохранённого черновика до записи: соединение и каталог моделей
     * для выбора. Черновик при этом в models.json не попадает.
     */
    suspend fun providerDraftCheck(baseUrl: String, keyEnv: String): ProviderDraftCheck =
        call(HttpMethod.Post, "/api/provider-profiles/draft-check", ProviderDraftCheck.serializer(), buildJsonObject {
            put("baseUrl", baseUrl)
            put("keyEnv", keyEnv)
        })

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

    /**
     * STOP.
     *
     * Таймаут короче остальных команд (20 с вместо 3 мин): отмена — это кнопка
     * «выйти из зависшего». Долгий таймаут держал бы её заблокированной, и до
     * истечения оператор не смог бы ни отменить, ни повторить попытку. Сервер
     * отвечает на отмену быстро: жёсткий стоп убивает процессы сразу, обычный
     * ждёт ответа RPC не дольше 10 с (pi.abortTimeoutMs).
     */
    // --- Follow Plan ---------------------------------------------------------

    /** Состояние режима «По плану»: читается и при выключенном на сервере флаге. */
    suspend fun plan(id: String): PlanStatus =
        get("/api/tasks/${id.path()}/plan", PlanStatus.serializer())

    /**
     * Подключить существующий Markdown-файл проекта. Модель не вызывается: это
     * только чтение и проверка файла.
     */
    suspend fun attachPlan(id: String, path: String, commandId: String): PlanStatus =
        planCommand(id, "attach", commandId, buildJsonObject {
            put("path", path)
            put("clientId", connection.clientId)
        })

    /**
     * Предпросмотр: что будет, если подключить этот файл. Ничего не пишет.
     * [contentBase64] — файл, выбранный системным диалогом; [path] — файл проекта.
     */
    suspend fun inspectPlan(id: String, path: String? = null, name: String? = null, contentBase64: String? = null): PlanInspection =
        call(HttpMethod.Post, "/api/tasks/${id.path()}/plan/inspect", PlanInspection.serializer(), buildJsonObject {
            path?.let { put("path", it) }
            name?.let { put("name", it) }
            contentBase64?.let { put("contentBase64", it) }
        })

    /** Один каталог проекта: папки и .md-файлы (телефон так выбирает файл на компьютере). */
    suspend fun browsePlan(id: String, path: String = ""): PlanBrowseListing =
        get("/api/tasks/${id.path()}/plan/browse?path=${path.encodeURLParameter()}", PlanBrowseListing.serializer())

    /** Подключить выбранный файл (записать в проект) или импортировать его после подтверждения. */
    suspend fun importPlan(
        id: String,
        commandId: String,
        path: String? = null,
        name: String? = null,
        contentBase64: String? = null,
        confirmImport: Boolean = false,
        overwrite: Boolean = false,
    ): PlanImportResult =
        call(HttpMethod.Post, "/api/tasks/${id.path()}/plan/import", PlanImportResult.serializer(), buildJsonObject {
            path?.let { put("path", it) }
            name?.let { put("name", it) }
            contentBase64?.let { put("contentBase64", it) }
            put("confirmImport", confirmImport)
            put("overwrite", overwrite)
            put("clientId", connection.clientId)
            put("commandId", commandId)
        })

    suspend fun planContent(id: String): PlanContent =
        get("/api/tasks/${id.path()}/plan/content", PlanContent.serializer())

    suspend fun savePlanContent(id: String, base: PlanContent, content: String, commandId: String): PlanStatus =
        planCommand(id, "content", commandId, buildJsonObject {
            put("content", content)
            put("expectedRevision", base.revision)
            put("expectedHash", base.hash)
            put("clientId", connection.clientId)
        })

    /** Убрать план: файл остаётся на месте, режим выключается. */
    suspend fun detachPlan(id: String, commandId: String): PlanStatus =
        planCommand(id, "detach", commandId, buildJsonObject { put("clientId", connection.clientId) })

    suspend fun startPlan(id: String, expectedRevision: Int?, commandId: String): PlanStatus =
        planCommand(id, "start", commandId, planBody(expectedRevision))

    suspend fun pausePlan(id: String, commandId: String): PlanStatus =
        planCommand(id, "pause", commandId, buildJsonObject { put("clientId", connection.clientId) })

    suspend fun resumePlan(id: String, expectedRevision: Int?, commandId: String): PlanStatus =
        planCommand(id, "resume", commandId, planBody(expectedRevision))

    suspend fun stopPlan(id: String, commandId: String): PlanStatus =
        planCommand(id, "stop", commandId, buildJsonObject { put("clientId", connection.clientId) })

    /** Снять конфликт, приняв версию файла с диска (правка оператора не теряется). */
    suspend fun reconcilePlan(id: String, expectedRevision: Int?, action: String, commandId: String): PlanStatus =
        planCommand(id, "reconcile", commandId, buildJsonObject {
            expectedRevision?.let { put("expectedRevision", it) }
            put("clientId", connection.clientId)
            put("action", action)
        })

    private fun planBody(expectedRevision: Int?) = buildJsonObject {
        expectedRevision?.let { put("expectedRevision", it) }
        put("clientId", connection.clientId)
    }

    private suspend fun planCommand(id: String, action: String, commandId: String, body: JsonObject): PlanStatus =
        call(HttpMethod.Post, "/api/tasks/${id.path()}/plan/$action", PlanStatus.serializer(), buildJsonObject {
            body.forEach { (key, value) -> put(key, value) }
            put("commandId", commandId)
        })

    suspend fun cancel(id: String, commandId: String? = null, hard: Boolean = false): Task =
        call(HttpMethod.Post, "/api/tasks/${id.path()}/cancel", Task.serializer(), buildJsonObject {
            commandId?.let { put("commandId", it) }
            put("clientId", connection.clientId)
            if (hard) put("hard", true)
        }, timeoutMs = 20_000L)

    suspend fun sendPendingNow(id: String, pendingId: String?): Task =
        call(HttpMethod.Post, "/api/tasks/${id.path()}/pending/send", Task.serializer(), buildJsonObject { pendingId?.let { put("pendingId", it) } })

    suspend fun dropPending(id: String, pendingId: String?): Task =
        call(HttpMethod.Delete, "/api/tasks/${id.path()}/pending" + (pendingId?.let { "?pendingId=${it.encodeURLParameter()}" } ?: ""), Task.serializer())

    suspend fun compact(id: String) {
        send(HttpMethod.Post, "/api/tasks/${id.path()}/compact", buildJsonObject { })
    }

    suspend fun restartSession(id: String): Task =
        call(HttpMethod.Post, "/api/tasks/${id.path()}/session/restart", Task.serializer(), buildJsonObject { })

    suspend fun trustWorkspace(id: String): Task =
        call(HttpMethod.Post, "/api/tasks/${id.path()}/workspace/trust", Task.serializer(), buildJsonObject { put("confirm", true) })

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

    /**
     * MR-07: тот же вопрос заново, но с параметрами — моделью и/или уровнем мышления.
     *
     * Параметры применяются к СЕССИИ, а не только к этому запросу: у Pi нет
     * переопределения на один запрос (`prompt(message)` плюс отдельные `set_model` и
     * `set_thinking_level`), и применённое видно в самой сессии. Отсутствующее поле не
     * отправляется — так один запрос служит и «только модель», и «только уровень».
     */
    suspend fun rerun(id: String, turnId: String?, model: ModelRef? = null, thinkingLevel: String? = null): Task =
        call(HttpMethod.Post, "/api/tasks/${id.path()}/rerun", Task.serializer(), buildJsonObject {
            turnId?.let { put("turnId", it) }
            model?.let { selection ->
                put("model", buildJsonObject {
                    selection.provider?.let { put("provider", it) }
                    put("id", selection.id.orEmpty())
                })
            }
            thinkingLevel?.let { put("thinkingLevel", it) }
        })

    suspend fun continueTurn(id: String, turnId: String?) {
        send(HttpMethod.Post, "/api/tasks/${id.path()}/continue", buildJsonObject { turnId?.let { put("turnId", it) } })
    }

    suspend fun selectVariant(id: String, turnSeq: Long, variantId: String) {
        send(HttpMethod.Post, "/api/tasks/${id.path()}/variant", buildJsonObject {
            put("turnSeq", turnSeq)
            put("variantId", variantId)
        })
    }

    /**
     * A new session with the conversation copied out of this one: through
     * [turnId] by default, or — with [from] — the chosen message and everything
     * after it.
     */
    suspend fun fork(id: String, turnId: String, from: Boolean = false): Task =
        call(HttpMethod.Post, "/api/tasks/${id.path()}/fork", Task.serializer(), buildJsonObject {
            put("turnId", turnId)
            if (from) put("direction", "from")
        })

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

    /**
     * URL файла рабочей папки. [from]/[to] — диапазон строк: сервер умеет отдавать
     * только запрошенный кусок, и тогда просмотрщик открывается на нужном месте
     * (клик по ссылке вида `src/a.kt#L120-L140` из чата).
     */
    fun workspaceFileUrl(id: String, path: String, from: Int? = null, to: Int? = null): String =
        "$base/api/tasks/${id.path()}/workspace-file?path=${path.encodeURLParameter()}" +
            (from?.let { "&from=$it&to=${to ?: it}" } ?: "")

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

    /**
     * Открывает папку, в которой работает сессия (`workspacePath`), файловым
     * менеджером ПК. Как и остальные «открыть на машине» — только клиенту, чей
     * адрес сама машина; у сессии без рабочей папки сервер отвечает 404.
     */
    suspend fun openWorkspaceFolder(id: String) {
        send(HttpMethod.Post, "/api/tasks/${id.path()}/workspace/open", buildJsonObject { put("confirm", true) })
    }

    /** The task's artifacts (tool output logs, diff patches), in the server's order. */
    suspend fun artifacts(id: String): List<String> =
        get("/api/tasks/${id.path()}/artifacts", ListSerializer(String.serializer()))

    /** Сколько места сессия занимает на диске компьютера (только измерение: сервер ничего не удаляет). */
    suspend fun sessionStorage(id: String): SessionStorage =
        get("/api/tasks/${id.path()}/storage", SessionStorage.serializer())

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
            coroutineScope {
                // A read deadline cannot protect a connection still waiting for headers.
                // Cancel this timer as soon as the response opens, not when the stream ends.
                val openingTimeout = launch {
                    delay(idleTimeoutMillis)
                    throw ApiException(ApiError.Unreachable("Сервер не открыл поток за ${idleTimeoutMillis / 1000} с"))
                }
                http.prepareRequest {
                    method = HttpMethod.Get
                    url("$base/api/tasks/${id.path()}/stream?after=$after")
                    header(HttpHeaders.Accept, "text/event-stream")
                    header("Last-Event-ID", after.toString())
                    authorize()
                }.execute { response ->
                    openingTimeout.cancel()
                    if (!response.status.isSuccess()) {
                        val body = kotlinx.coroutines.withTimeoutOrNull(idleTimeoutMillis) { response.bodyAsText() }
                            ?: throw ApiException(ApiError.Unreachable("Сервер не завершил ответ с ошибкой за ${idleTimeoutMillis / 1000} с"))
                        throw ApiException(apiErrorOf(response.status.value, body))
                    }
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

    private suspend fun <T> call(method: HttpMethod, path: String, serializer: KSerializer<T>, body: kotlinx.serialization.json.JsonElement? = null, timeoutMs: Long? = null): T =
        decode(send(method, path, body, timeoutMs), serializer)

    private suspend fun send(method: HttpMethod, path: String, body: kotlinx.serialization.json.JsonElement? = null, timeoutMs: Long? = null): HttpResponse {
        val response = guard {
            withTimeout(timeoutMs ?: if (method == HttpMethod.Get) 30_000L else 180_000L) { http.request {
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
