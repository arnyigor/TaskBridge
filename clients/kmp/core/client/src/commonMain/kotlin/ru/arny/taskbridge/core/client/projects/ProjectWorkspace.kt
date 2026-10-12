package ru.arny.taskbridge.core.client.projects

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import ru.arny.taskbridge.core.api.ApiException
import ru.arny.taskbridge.core.api.Invocation
import ru.arny.taskbridge.core.api.RunRecipe
import ru.arny.taskbridge.core.api.Schedule
import ru.arny.taskbridge.core.api.ScheduleRequest
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.api.WorkItem

data class ProjectWorkspaceState(
    val projectId: String,
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val workItems: List<WorkItem> = emptyList(),
    val recipes: List<RunRecipe> = emptyList(),
    val schedules: List<Schedule> = emptyList(),
    val invocations: List<Invocation> = emptyList(),
    val busyIds: Set<String> = emptySet(),
    val error: String? = null,
) {
    val openWorkItems: List<WorkItem>
        get() = workItems.filter { it.open }.sortedWith(compareBy<WorkItem> { it.priority ?: Int.MAX_VALUE }.thenByDescending { it.updatedAt.orEmpty() })

    fun schedulesFor(recipeId: String): List<Schedule> = schedules.filter { it.recipeId == recipeId }

    fun latestInvocation(recipeId: String): Invocation? = invocations
        .filter { it.recipeId == recipeId }
        .maxByOrNull { it.startedAt ?: it.scheduledAt ?: "" }
}

/**
 * Project-scoped operational state: Work Items plus recurring recipes, schedules
 * and their latest invocations. Recipe, schedule and invocation remain separate
 * entities; this controller only joins them for the dashboard.
 */
class ProjectWorkspace(
    private val api: TaskBridgeApi,
    private val projectId: String,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(ProjectWorkspaceState(projectId))
    val state: StateFlow<ProjectWorkspaceState> = _state.asStateFlow()

    fun start() {
        if (_state.value.loading && !_state.value.refreshing) scope.launch { load(initial = true) }
    }

    fun refresh() {
        if (_state.value.refreshing) return
        scope.launch { load(initial = false) }
    }

    private suspend fun load(initial: Boolean) {
        _state.update { it.copy(loading = initial && it.workItems.isEmpty() && it.recipes.isEmpty(), refreshing = !initial, error = null) }
        try {
            val (workItems, recipes, allSchedules) = coroutineScope {
                val work = async { api.workItems(projectId = projectId) }
                val recipeList = async { api.recipes(projectId = projectId) }
                val scheduleList = async { api.schedules() }
                Triple(work.await(), recipeList.await(), scheduleList.await())
            }
            // The API limit is global unless recipeId is supplied. Fetching the
            // newest 200 globally can hide this project's last run behind activity
            // from other projects, so each displayed recipe asks for its own latest.
            val latestInvocations = coroutineScope {
                recipes.map { recipe -> async { api.invocations(recipeId = recipe.id, limit = 1).firstOrNull() } }
                    .awaitAll()
                    .filterNotNull()
            }
            val recipeIds = recipes.mapTo(mutableSetOf()) { it.id }
            _state.update {
                it.copy(
                    loading = false,
                    refreshing = false,
                    workItems = workItems,
                    recipes = recipes,
                    schedules = allSchedules.filter { schedule -> schedule.recipeId in recipeIds },
                    invocations = latestInvocations,
                    error = null,
                )
            }
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (failure: Throwable) {
            val message = (failure as? ApiException)?.error?.message ?: failure.message ?: "Не удалось загрузить проект"
            _state.update { it.copy(loading = false, refreshing = false, error = message) }
        }
    }

    /** Runs through the durable schedule path when one exists; otherwise runs the recipe directly. */
    suspend fun runNow(recipeId: String): Result<String> = action(recipeId) {
        val schedule = _state.value.schedulesFor(recipeId).firstOrNull { it.enabled }
        val sessionId = if (schedule != null) {
            api.runScheduleNow(schedule.id).sessionId
                ?: error("Планировщик не вернул сессию запуска")
        } else {
            api.runRecipe(recipeId).task.id
        }
        refresh()
        sessionId
    }

    suspend fun setScheduleEnabled(scheduleId: String, enabled: Boolean): Result<Schedule> = action(scheduleId) {
        val updated = api.updateSchedule(scheduleId, ScheduleRequest(enabled = enabled))
        _state.update { current ->
            current.copy(schedules = current.schedules.map { if (it.id == scheduleId) updated else it })
        }
        updated
    }

    private suspend fun <T> action(id: String, block: suspend () -> T): Result<T> {
        if (id in _state.value.busyIds) return Result.failure(IllegalStateException("Операция уже выполняется"))
        _state.update { it.copy(busyIds = it.busyIds + id) }
        return try {
            Result.success(block())
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (failure: Throwable) {
            Result.failure(failure)
        } finally {
            _state.update { it.copy(busyIds = it.busyIds - id) }
        }
    }
}
