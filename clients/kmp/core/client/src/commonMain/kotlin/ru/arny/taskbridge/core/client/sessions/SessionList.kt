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
import ru.arny.taskbridge.core.api.ProjectOverview
import ru.arny.taskbridge.core.api.ProjectPreferences
import ru.arny.taskbridge.core.api.ProjectSummary
import ru.arny.taskbridge.core.api.SCRATCH_PROJECT_ID
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.api.UploadFile

data class SessionGroup(val projectId: String, val title: String, val sessions: List<Task>)

/** Сессии без проекта: своя папка в списке. */
internal const val SCRATCH_TITLE = "Без проекта"

/**
 * Имя папки из того, что записано в реестре: последний сегмент пути.
 * `G:\Android\Projects\Taskbridge` → `Taskbridge`, `/srv/app/taskbridge` → `taskbridge`.
 */
internal fun folderNameOf(label: String): String {
    val trimmed = label.trim().trimEnd('/', '\\')
    return trimmed.substringAfterLast('/').substringAfterLast('\\').ifBlank { trimmed }
}

data class SessionListState(
    val loading: Boolean = true,
    val tasks: List<Task> = emptyList(),
    val projects: List<Project> = emptyList(),
    /** The project dashboard (MR-01): counts, pinned and archived, from one GET. */
    val overview: ProjectOverview? = null,
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

    /** The dashboard's order: the server already pinned-first, archived in place. */
    val dashboardProjects: List<ProjectSummary> get() = overview?.projects.orEmpty()

    /**
     * Название папки сессии — только имя папки проекта, без пути.
     * В реестре иногда записан полный путь, а в заголовке строки он не нужен.
     */
    fun folderName(projectId: String?): String {
        val id = projectId ?: SCRATCH_PROJECT_ID
        if (id == SCRATCH_PROJECT_ID) return SCRATCH_TITLE
        return folderNameOf(projects.firstOrNull { it.id == id }?.displayName ?: id)
    }

    fun groups(query: String = "", projectId: String? = null): List<SessionGroup> {
        val needle = query.trim().lowercase()
        return sorted
            .filter { projectId == null || (it.projectId ?: SCRATCH_PROJECT_ID) == projectId }
            .filter { needle.isEmpty() || it.displayTitle.lowercase().contains(needle) || it.prompt.orEmpty().lowercase().contains(needle) }
            .groupBy { it.projectId ?: SCRATCH_PROJECT_ID }
            .map { (id, list) -> SessionGroup(id, folderName(id), list) }
            .sortedBy { group -> group.sessions.minOf { displayStateOf(it).order.coerceAtMost(3) } * 1_000 + (projects.indexOfFirst { it.id == group.projectId }.takeIf { it >= 0 } ?: 999) }
    }
}

/**
 * Как часто опрашивать список сессий (раздел 4.3 плана, «красная» для оператора:
 * расход батареи).
 *
 * Правила простые и проверяемые:
 *  - экран виден и есть непокрытая потоком работа — короткий опрос (5 с);
 *  - единственная активная сессия уже покрыта видимым SSE — редкий контрольный
 *    опрос (30 с), как и при отсутствии работы;
 *  - приложение в фоне — опрос нужен только ради уведомлений, и только пока работа
 *    реально идёт; без активной работы фоновый опрос останавливается совсем (0 =
 *    спать до возврата в foreground). Так телефон не жжёт батарею на пустых запросах.
 *  - в фоне ход идёт — [BACKGROUND_ACTIVE_INTERVAL_MS], а не 5 с: конец хода
 *    присылает wake-канал сервера (4.3), частый опрос лишь дублировал бы push.
 *  - в фоне все активные сессии ждут ответа оператора — [BACKGROUND_AWAITING_USER_MS]:
 *    до его действия не меняется ничего, поэтому 5 с здесь не покупали ничего.
 *  - режим экономии энергии удлиняет интервал в фоне: система уже сказала, что
 *    батарея важнее свежести на секунду.
 */
fun sessionPollIntervalMillis(
    active: Boolean,
    inForeground: Boolean = true,
    powerSave: Boolean = false,
    /** Единственная активная сессия уже обновляется видимым SSE. */
    activeCoveredByStream: Boolean = false,
    /** Все активные сессии ждут ответа оператора: до его действия данные не меняются. */
    awaitingUserOnly: Boolean = false,
    activeIntervalMillis: Long = 5_000,
    idleIntervalMillis: Long = 30_000,
    backgroundActiveMillis: Long = BACKGROUND_ACTIVE_INTERVAL_MS,
    backgroundAwaitingUserMillis: Long = BACKGROUND_AWAITING_USER_MS,
): Long = when {
    inForeground -> if (active && !activeCoveredByStream) activeIntervalMillis else idleIntervalMillis
    !active -> 0L
    awaitingUserOnly -> backgroundAwaitingUserMillis
    powerSave -> idleIntervalMillis
    else -> backgroundActiveMillis
}

/**
 * Фон, ход идёт: конец хода сервер присылает wake-каналом, опрос — только страховка
 * на случай промаха push (телефон спал, Wi-Fi оборвался).
 */
const val BACKGROUND_ACTIVE_INTERVAL_MS = 20_000L

/** Фон, все активные сессии ждут ответа оператора: до его действия не меняется ничего. */
const val BACKGROUND_AWAITING_USER_MS = 60_000L

/** 0 — опрос приостановлен: ждём возврата в foreground или пробуждения по сети. */
fun shouldPoll(intervalMillis: Long): Boolean = intervalMillis > 0L

/**
 * The main screen's data: sessions, projects and host info, polled while the
 * screen is visible (a list stream, `/api/stream`, is backend plan B3; until
 * then a short poll is what keeps states in step with the browser and CLI).
 */
class SessionList(
    private val api: TaskBridgeApi,
    private val scope: CoroutineScope,
    private val clockMillis: () -> Long,
    private val activeIntervalMillis: Long = 5_000,
    private val idleIntervalMillis: Long = 30_000,
    private val backgroundActiveMillis: Long = BACKGROUND_ACTIVE_INTERVAL_MS,
    private val backgroundAwaitingUserMillis: Long = BACKGROUND_AWAITING_USER_MS,
    /** Виден ли экран приложения: в фоне опрос нужен только ради уведомлений (4.3). */
    private val inForeground: () -> Boolean = { true },
    /** Режим экономии энергии: интервалы удлиняются. */
    private val powerSave: () -> Boolean = { false },
    /** Id сессии, уже покрытой единственным foreground SSE; null — потока нет. */
    private val streamedTaskId: () -> String? = { null },
    /** Desktop: поднимает потушенный сервер скрытым процессом, без консоли (см. DesktopServerLauncher). */
    private val startLocalServer: (suspend () -> Unit)? = null,
    /**
     * Может ли [startLocalServer] вообще сработать: на desktop это найденный корень
     * TaskBridge (`scripts/start-lan.mjs`). Без него обещание «запустим на этом
     * компьютере» — ложь, и диалог должен говорить другое.
     */
    private val localServerAvailable: () -> Boolean = { startLocalServer != null },
) {
    private val _state = MutableStateFlow(SessionListState())
    val state: StateFlow<SessionListState> = _state.asStateFlow()

    /**
     * Sessions being or just deleted. Deleting takes the server seconds (it
     * stops Pi first), and a poll started before it ended still lists the
     * session: without this it came back, and a second delete got 404.
     * An id leaves the set once a poll no longer lists it.
     */
    private val hidden = MutableStateFlow<Set<String>>(emptySet())
    private var job: Job? = null
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private var infoTick = 0

    fun start() {
        if (job?.isActive == true) return
        job = scope.launch {
            fun intervalForCurrentState(): Long {
                val tasks = _state.value.tasks
                val activeTasks = tasks.filter { displayStateOf(it).active }
                val streamed = streamedTaskId()
                return sessionPollIntervalMillis(
                    active = activeTasks.isNotEmpty(),
                    inForeground = inForeground(),
                    powerSave = powerSave(),
                    activeCoveredByStream = activeTasks.size == 1 && activeTasks.single().id == streamed,
                    awaitingUserOnly = activeTasks.isNotEmpty() && activeTasks.all { displayStateOf(it) == DisplayState.WAITING_USER },
                    activeIntervalMillis = activeIntervalMillis,
                    idleIntervalMillis = idleIntervalMillis,
                    backgroundActiveMillis = backgroundActiveMillis,
                    backgroundAwaitingUserMillis = backgroundAwaitingUserMillis,
                )
            }

            while (true) {
                var interval = intervalForCurrentState()
                // В фоне без работы не опрашиваем вообще: будит возврат в foreground,
                // событие сети или действие оператора. После load пересчитываем интервал
                // по свежему состоянию: новая active-сессия не должна ждать 30 секунд.
                if (shouldPoll(interval)) {
                    load()
                    interval = intervalForCurrentState()
                }
                withTimeoutOrNull(if (shouldPoll(interval)) interval else Long.MAX_VALUE) { wake.receive() }
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

        /**
     * Свежая телеметрия движка (`/api/info`) без перезагрузки списка.
     *
     * Фаза модели («reading the prompt» у Strata), прогресс чтения промпта и PP/TG живут
     * только в `/api/info`: в SSE их нет. Пока открыт чат, список опрашивается редко —
     * единственная активная сессия уже обновляется через SSE, и `sessionPollIntervalMillis`
     * даёт ей idle-интервал 30 с. Без этого вызова статус застывал на значении, снятом
     * при открытии чата: 2026-10-22 Strata читала промпт, а TaskBridge писал «ожидается
     * ответ агента» (STAB-STATUS-01).
     */
    suspend fun refreshInfo() {
        runCatching { api.info() }.onSuccess { info -> _state.update { it.copy(info = info) } }
    }

    fun refresh() {
        infoTick = 0
        _state.update { it.copy(refreshing = true) }
        wake.trySend(Unit)
    }

    suspend fun projectFolders(path: String? = null) = runCatching { api.projectFolders(path) }

    suspend fun registerProject(path: String, name: String): Result<ru.arny.taskbridge.core.api.Project> = runCatching {
        val project = api.registerProject(path, name)
        _state.update { current -> current.copy(projects = current.projects + project) }
        infoTick = 0
        refresh()
        project
    }

    suspend fun registerLocalProject(path: String): Result<ru.arny.taskbridge.core.api.Project> = runCatching {
        val project = api.registerLocalProject(path)
        _state.update { current -> current.copy(projects = current.projects.filterNot { it.id == project.id } + project) }
        infoTick = 0
        refresh()
        project
    }

    private suspend fun load() {
        try {
            val listed = api.tasks()
            hidden.update { ids -> ids.filterTo(mutableSetOf()) { id -> listed.any { it.id == id } } }
            val tasks = listed.filterNot { it.id in hidden.value }
            val projects = if (_state.value.projects.isEmpty() || infoTick % 10 == 0) api.projects() else _state.value.projects
            // The dashboard is read on the same cadence as the project registry (and
            // right after a preference change, see [setProjectPreferences]): an extra
            // request per tick would buy nothing while nothing can change it.
            val overview = if (_state.value.overview == null || infoTick % 10 == 0) api.projectOverview() else _state.value.overview
            val active = tasks.any { displayStateOf(it).active }
            val info = if (_state.value.info == null || active || infoTick % 5 == 0) api.info() else _state.value.info
            infoTick += 1
            _state.update {
                it.copy(
                    loading = false, refreshing = false, tasks = tasks, projects = projects,
                    overview = overview, info = info, error = null, updatedAtMillis = clockMillis(),
                )
            }
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (failure: ApiException) {
            _state.update { it.copy(loading = false, refreshing = false, error = failure.error) }
        }
    }

    /**
     * Pin or archive a project (MR-01). The server is the one that decides the
     * merged result (an omitted flag keeps its stored value), so its answer is
     * what lands in the state — not an optimistic guess that could disagree.
     */
    suspend fun setProjectPreferences(projectId: String, pinned: Boolean? = null, archived: Boolean? = null): Result<ProjectPreferences> = runCatching {
        val preferences = api.setProjectPreferences(projectId, pinned, archived)
        _state.update { current ->
            val overview = current.overview ?: return@update current
            current.copy(
                overview = overview.copy(
                    projects = overview.projects.map { project ->
                        if (project.id != projectId) project
                        else project.copy(pinned = preferences.pinned, archived = preferences.archived)
                    },
                ),
            )
        }
        wake.trySend(Unit)
        preferences
    }

    /** Поднимет ли приложение сервер само: лаунчер есть и каталог TaskBridge найден. */
    fun canStartLocalServer(): Boolean = startLocalServer != null && localServerAvailable()

    /**
     * Перезапуск TaskBridge на ПК; возвращается, когда отвечает новый процесс.
     * Если сервер вообще не отвечает, desktop-клиент ЗАПУСКАЕТ его сам —
     * скрытым процессом через [startLocalServer], без консольного окна; Android
     * в этом случае сразу сообщает, что сервер надо запустить на компьютере.
     */
    suspend fun restartServer(timeoutMillis: Long = 120_000, stepMillis: Long = 700): Result<Unit> = runCatching {
        val before = runCatching { api.info().bootId }.getOrNull()
        if (before == null) {
            val launch = startLocalServer
                ?: throw IllegalStateException("Сервер недоступен — запустите TaskBridge на компьютере (start.cmd)")
            if (!localServerAvailable()) throw IllegalStateException(
                "Сервер недоступен, а запустить его из приложения нельзя: каталог TaskBridge " +
                    "(scripts/start-lan.mjs) не найден — укажите его в настройках приложения",
            )
            launch()
        } else {
            api.restartServer()
        }
        val back = withTimeoutOrNull(timeoutMillis) {
            while (true) {
                delay(stepMillis)
                val now = runCatching { api.info().bootId }.getOrNull()
                // A 202 response only means the detached worker was scheduled.
                // The old process can keep answering during its grace delay, so
                // success requires the new bootId (or the first live boot after
                // starting from a fully stopped server).
                if (now != null && (before == null || now != before)) break
            }
        }
        if (back == null) throw IllegalStateException("Сервер не вернулся за ${timeoutMillis / 1000} с — проверьте логи TaskBridge на компьютере")
        infoTick = 0 // a new process: read its info and projects again
        refresh()
    }

    private var cachedModels: ModelCatalog? = null

    /** Show the last catalogue immediately while the server refreshes it. */
    fun peekModels(): ModelCatalog? = cachedModels

    suspend fun models(refresh: Boolean = false): Result<ModelCatalog> = runCatching {
        api.models(refresh).also { cachedModels = it }
    }

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

    /** Drops a session deleted elsewhere (from its chat) from the list, and keeps a stale poll from bringing it back. */
    fun forget(taskId: String) {
        hidden.update { it + taskId }
        _state.update { s -> s.copy(tasks = s.tasks.filterNot { it.id == taskId }) }
    }

    /** Hides the session at once; "not found" means it is already gone, which is success. */
    suspend fun delete(taskId: String): Result<Unit> {
        forget(taskId)
        return runCatching { api.delete(taskId) }
            .recoverCatching { if ((it as? ApiException)?.error !is ApiError.NotFound) throw it }
            .onFailure {
                hidden.update { ids -> ids - taskId }
                wake.trySend(Unit)
            }
    }

    suspend fun rename(taskId: String, title: String): Result<Unit> = runCatching {
        val task = api.rename(taskId, title.trim())
        _state.update { s -> s.copy(tasks = s.tasks.map { if (it.id == taskId) task else it }) }
    }
}
