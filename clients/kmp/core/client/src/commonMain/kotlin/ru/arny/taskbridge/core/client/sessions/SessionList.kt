package ru.arny.taskbridge.core.client.sessions

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withTimeoutOrNull
import ru.arny.taskbridge.core.api.ApiError
import ru.arny.taskbridge.core.api.ApiException
import ru.arny.taskbridge.core.api.ApiInfo
import ru.arny.taskbridge.core.api.CreateTaskRequest
import ru.arny.taskbridge.core.api.ModelCatalog
import ru.arny.taskbridge.core.api.ModelRef
import ru.arny.taskbridge.core.api.ModelSelection
import ru.arny.taskbridge.core.api.ModelVisibility
import ru.arny.taskbridge.core.api.Project
import ru.arny.taskbridge.core.api.ProjectOverview
import ru.arny.taskbridge.core.api.ProjectPreferences
import ru.arny.taskbridge.core.api.ProjectSummary
import ru.arny.taskbridge.core.api.SCRATCH_PROJECT_ID
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.api.UploadFile

data class SessionGroup(val projectId: String, val title: String, val sessions: List<Task>)

/**
 * Порядок папок проектов в списке сессий. Закреплённые папки всегда выше
 * остальных — в этом и смысл закрепления — поэтому [sortBy] решает только
 * порядок незакреплённых.
 */
enum class FolderSortBy {
    /** Сначала папки, где работа ждёт оператора или идёт, затем по свежести. */
    ACTIVITY,
    /** По алфавиту имени папки. */
    NAME;

    val stored: String get() = name.lowercase()

    companion object {
        fun ofStored(value: String?): FolderSortBy = when (value) {
            "name" -> NAME
            else -> ACTIVITY
        }
    }
}

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

    /** Закреплённые проекты: их папки стоят в списке сессий выше остальных. */
    val pinnedProjectIds: Set<String>
        get() = dashboardProjects.filter { it.pinned && !it.archived }.mapTo(mutableSetOf()) { it.id }

    /** Архивные проекты: их папки в общем списке не показываются, а живут в «Архиве». */
    val archivedProjectIds: Set<String>
        get() = dashboardProjects.filter { it.archived }.mapTo(mutableSetOf()) { it.id }

    /** Проект известен реестру: только у такого есть закрепление и архив. */
    fun isRegisteredProject(projectId: String): Boolean = dashboardProjects.any { it.id == projectId }

    /**
     * Название папки сессии — только имя папки проекта, без пути.
     * В реестре иногда записан полный путь, а в заголовке строки он не нужен.
     */
    fun folderName(projectId: String?): String {
        val id = projectId ?: SCRATCH_PROJECT_ID
        if (id == SCRATCH_PROJECT_ID) return SCRATCH_TITLE
        return folderNameOf(projects.firstOrNull { it.id == id }?.displayName ?: id)
    }

    /**
     * [base] — уже отсортированный список ([sorted]): экран считает его один раз в remember.
     * [sortBy] задаёт порядок *папок* (сессии внутри папки всегда сверху важные);
     * [projectId] — заход внутрь одного проекта с дашборда: тогда архив не скрывается,
     * иначе папка исчезла бы прямо из-под ног.
     */
    fun groups(
        query: String = "",
        projectId: String? = null,
        sortBy: FolderSortBy = FolderSortBy.ACTIVITY,
        base: List<Task> = sorted,
    ): List<SessionGroup> {
        val needle = query.trim().lowercase()
        val archived = if (projectId == null) archivedProjectIds else emptySet()
        val pinned = pinnedProjectIds
        val filtered = base
            .filter { projectId == null || (it.projectId ?: SCRATCH_PROJECT_ID) == projectId }
            .filter { (it.projectId ?: SCRATCH_PROJECT_ID) !in archived }
            .filter { needle.isEmpty() || it.displayTitle.lowercase().contains(needle) || it.prompt.orEmpty().lowercase().contains(needle) }
        return filtered
            .groupBy { it.projectId ?: SCRATCH_PROJECT_ID }
            .map { (id, list) ->
                val order = list.minOf { displayStateOf(it).order.coerceAtMost(3) }
                val index = projects.indexOfFirst { it.id == id }.takeIf { it >= 0 } ?: 999
                Triple(SessionGroup(id, folderName(id), list), order, index)
            }
            // Закреплённая папка — сразу под блоком активных сессий; внутри каждой
            // половины решает выбранная сортировка. Индекс в реестре — чтобы при равной
            // активности порядок не скакал от опроса к опросу.
            .sortedWith(
                compareByDescending<Triple<SessionGroup, Int, Int>> { it.first.projectId in pinned }
                    .thenBy { if (sortBy == FolderSortBy.NAME) 0 else it.second }
                    .thenBy { if (sortBy == FolderSortBy.NAME) it.first.title.lowercase() else "" }
                    .thenBy { it.third },
            )
            .map { it.first }
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
 *  - в фоне все активные сессии ждут ответа оператора — опрос не идёт совсем (0):
 *    до его действия не меняется ничего, а любое периодическое пробуждение в фоне
 *    системный детектор телефона (OnePlus `[BgDetect]`) считает расходом и убивает
 *    приложение (замер 2026-10-30/31: уведомление «расходует заряд» и force stop).
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
): Long = when {
    inForeground -> if (active && !activeCoveredByStream) activeIntervalMillis else idleIntervalMillis
    !active -> 0L
    awaitingUserOnly -> 0L
    powerSave -> backgroundActiveMillis * 2
    else -> backgroundActiveMillis
}

/**
 * Фон, ход идёт: конец хода сервер присылает wake-каналом (проверено на спящем
 * телефоне 2026-11-01: `POST /wake` → 204, процесс просыпается и обновляется),
 * поэтому опрос — только страховка на случай промаха push: раз в 3 минуты.
 */
const val BACKGROUND_ACTIVE_INTERVAL_MS = 180_000L

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
    suspend fun restartServer(
        timeoutMillis: Long = 120_000,
        stepMillis: Long = 700,
        /** Сколько ждать ответ на сам POST: сервер обычно умирает, не ответив. */
        kickTimeoutMillis: Long = 10_000,
    ): Result<Unit> = runCatching {
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
            // Сервер убивает себя, не успев ответить: ждать ответ дольше таймаута соединения
            // бессмысленно — раньше это висело как «Перезапуск сервера…» до 180 с.
            // Поэтому просьба отправляется без разбора ответа: успех решает новый bootId
            // в опросе ниже, а он ограничен timeoutMillis.
            runCatching { api.restartServer(kickTimeoutMillis) }
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
        // Перезапуск уже случился; неудача первой загрузки списка — не причина сообщать
        // «сервер не перезапустился».
        runCatching { refresh() }
    }

    private var cachedModels: ModelCatalog? = null
    private var cachedVisibility: ModelVisibility? = null

    /** Show the last catalogue immediately while the server refreshes it. */
    fun peekModels(): ModelCatalog? = cachedModels

    suspend fun models(refresh: Boolean = false): Result<ModelCatalog> = runCatching {
        val catalog = api.models(refresh)
        // Скрытые провайдеры/модели не показываются в выборе модели: фильтр — здесь,
        // чтобы покрыть все пикеры сразу (чат, новая сессия, повтор с параметрами).
        // Редактор models.json берёт профили напрямую и фильтр не затрагивает.
        cachedVisibility = runCatching { api.modelVisibility() }.getOrNull() ?: cachedVisibility
        val visibility = cachedVisibility
        val filtered = if (visibility == null) catalog else catalog.copy(
            models = catalog.models.filterNot { visibility.filters(it.provider, it.id) },
        )
        cachedModels = filtered
        filtered
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

    /** Удаляет сразу несколько сессий. Сервер на каждую гасит движок Pi, чистит диск и БД,
     *  поэтому строгая очередь из двадцати сессий растягивалась на минуты: пачки по несколько
     *  штук перекрывают ожидание. [onDeleted] зовётся после каждой — экран по ней закрывает
     *  чат и показывает прогресс. Возвращает число неудач. */
    suspend fun deleteMany(
        ids: Collection<String>,
        concurrency: Int = 3,
        onDeleted: (id: String, done: Int, failed: Int) -> Unit = { _, _, _ -> },
    ): Int = coroutineScope {
        val gate = Semaphore(concurrency.coerceAtLeast(1))
        var done = 0
        var failed = 0
        ids.map { id ->
            async {
                gate.withPermit {
                    val failure = delete(id).isFailure
                    // Счётчики трогаются только здесь — на UI-потоке вызывающего — иначе
                    // два одновременных удаления теряли бы одно из приращений.
                    if (failure) failed++ else done++
                    onDeleted(id, done, failed)
                }
            }
        }.awaitAll()
        failed
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
