package ru.arny.taskbridge.core.client.sessions

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import ru.arny.taskbridge.core.api.ApiError
import ru.arny.taskbridge.core.api.ApiException
import ru.arny.taskbridge.core.api.ApiInfo
import ru.arny.taskbridge.core.api.CreateTaskRequest
import ru.arny.taskbridge.core.api.ModelCatalog
import ru.arny.taskbridge.core.api.ModelRef
import ru.arny.taskbridge.core.api.ModelSelection
import ru.arny.taskbridge.core.api.Project
import ru.arny.taskbridge.core.api.SCRATCH_PROJECT_ID
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.api.UploadFile

data class SessionGroup(val projectId: String, val title: String, val sessions: List<Task>)

data class SessionListState(
    val loading: Boolean = true,
    val tasks: List<Task> = emptyList(),
    val projects: List<Project> = emptyList(),
    val info: ApiInfo? = null,
    val error: ApiError? = null,
    val refreshing: Boolean = false,
    /** When the list was last read from the daemon (for the offline hint). */
    val updatedAtMillis: Long? = null,
) {
    /** Sessions that wait for the operator first, then working ones, then by recency. */
    val sorted: List<Task>
        get() = tasks.sortedWith(compareBy<Task> { displayStateOf(it).order.coerceAtMost(3) }.thenByDescending { it.updatedAt.orEmpty() })

    val waitingCount: Int get() = tasks.count { displayStateOf(it) == DisplayState.WAITING_USER }
    val workingCount: Int get() = tasks.count { displayStateOf(it) == DisplayState.WORKING }

    fun groups(query: String = ""): List<SessionGroup> {
        val needle = query.trim().lowercase()
        val names = projects.associate { it.id to it.displayName }
        return sorted
            .filter { needle.isEmpty() || it.displayTitle.lowercase().contains(needle) || it.prompt.orEmpty().lowercase().contains(needle) }
            .groupBy { it.projectId ?: SCRATCH_PROJECT_ID }
            .map { (id, list) -> SessionGroup(id, if (id == SCRATCH_PROJECT_ID) "Без проекта" else names[id] ?: id, list) }
            .sortedBy { group -> group.sessions.minOf { displayStateOf(it).order.coerceAtMost(3) } * 1_000 + (projects.indexOfFirst { it.id == group.projectId }.takeIf { it >= 0 } ?: 999) }
    }
}

/**
 * The main screen's data: sessions, projects and host info, polled while the
 * screen is visible (a list stream, `/api/stream`, is backend plan B3; until
 * then a short poll is what keeps states in step with the browser and CLI).
 */
class SessionList(
    private val api: TaskBridgeApi,
    private val scope: CoroutineScope,
    private val clockMillis: () -> Long,
    private val activeIntervalMillis: Long = 3_000,
    private val idleIntervalMillis: Long = 10_000,
) {
    private val _state = MutableStateFlow(SessionListState())
    val state: StateFlow<SessionListState> = _state.asStateFlow()

    private var job: Job? = null
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private var infoTick = 0

    fun start() {
        if (job?.isActive == true) return
        job = scope.launch {
            while (true) {
                load()
                val active = _state.value.tasks.any { displayStateOf(it).active }
                withTimeoutOrNull(if (active) activeIntervalMillis else idleIntervalMillis) { wake.receive() }
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    fun refresh() {
        _state.update { it.copy(refreshing = true) }
        wake.trySend(Unit)
    }

    private suspend fun load() {
        try {
            val tasks = api.tasks()
            val projects = if (_state.value.projects.isEmpty() || infoTick % 10 == 0) api.projects() else _state.value.projects
            val info = if (_state.value.info == null || infoTick % 5 == 0) api.info() else _state.value.info
            infoTick += 1
            _state.update { it.copy(loading = false, refreshing = false, tasks = tasks, projects = projects, info = info, error = null, updatedAtMillis = clockMillis()) }
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (failure: ApiException) {
            _state.update { it.copy(loading = false, refreshing = false, error = failure.error) }
        }
    }

    suspend fun models(refresh: Boolean = false): Result<ModelCatalog> = runCatching { api.models(refresh) }

    /** Creates a session; files go up first and travel with the first prompt. */
    suspend fun create(
        projectId: String,
        prompt: String,
        model: ModelRef?,
        thinkingLevel: String?,
        title: String?,
        files: List<UploadFile>,
        commandId: String,
    ): Result<Task> = runCatching {
        val upload = if (files.isNotEmpty()) api.upload(files) else null
        val task = api.createTask(
            CreateTaskRequest(
                projectId = projectId,
                prompt = prompt.trim(),
                title = title?.trim()?.takeIf { it.isNotEmpty() },
                model = model?.id?.let { ModelSelection(model.provider, it) },
                thinkingLevel = thinkingLevel,
                uploadToken = upload?.token,
                files = upload?.files?.mapNotNull { it.id }?.map { ru.arny.taskbridge.core.api.UploadedFileId(it) },
                commandId = commandId,
            ),
        )
        _state.update { s -> s.copy(tasks = listOf(task) + s.tasks.filterNot { it.id == task.id }) }
        wake.trySend(Unit)
        task
    }

    suspend fun delete(taskId: String): Result<Unit> = runCatching {
        api.delete(taskId)
        _state.update { s -> s.copy(tasks = s.tasks.filterNot { it.id == taskId }) }
    }

    suspend fun rename(taskId: String, title: String): Result<Unit> = runCatching {
        val task = api.rename(taskId, title.trim())
        _state.update { s -> s.copy(tasks = s.tasks.map { if (it.id == taskId) task else it }) }
    }
}
