package ru.arny.taskbridge.core.client.projects

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import ru.arny.taskbridge.core.api.ApiException
import ru.arny.taskbridge.core.api.ProjectMemoryHit
import ru.arny.taskbridge.core.api.ProjectMemoryOverview
import ru.arny.taskbridge.core.api.TaskBridgeApi

data class ProjectMemoryState(
    val projectId: String,
    val loading: Boolean = true,
    val overview: ProjectMemoryOverview? = null,
    /** Текст в поле поиска — он живёт здесь, чтобы список результатов ему не противоречил. */
    val query: String = "",
    /** Заполнено, когда поиск уже выполнялся: пустой список — «ничего не найдено». */
    val hits: List<ProjectMemoryHit>? = null,
    val searching: Boolean = false,
    val error: String? = null,
)

/**
 * Память проекта глазами оператора (MR-10, «Project → Knowledge»).
 *
 * Инспектор только читает — он показывает ровно тот путь, которым память попадает в
 * промпт, и ничего в неё не пишет. Поиск запускается явно (кнопка или Enter), а не на
 * каждое нажатие клавиши: запрос — чтение файлов памяти на сервере.
 */
class ProjectMemory(
    private val api: TaskBridgeApi,
    private val projectId: String,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(ProjectMemoryState(projectId))
    val state: StateFlow<ProjectMemoryState> = _state.asStateFlow()

    private var searchJob: Job? = null

    fun start() {
        if (_state.value.overview != null || !_state.value.loading) return
        scope.launch { load(initial = true) }
    }

    fun refresh() {
        scope.launch { load(initial = false) }
    }

    /** Обзор памяти: размер инъекции, категории, проблемы. */
    private suspend fun load(initial: Boolean) {
        _state.update { it.copy(loading = initial && it.overview == null, error = null) }
        try {
            val overview = api.projectMemory(projectId)
            _state.update { it.copy(loading = false, overview = overview, error = null) }
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (failure: Throwable) {
            _state.update { it.copy(loading = false, error = messageOf(failure)) }
        }
    }

    /** Явный поиск: пустая строка — законный запрос, сервер отдаёт первые записи. */
    fun search(query: String) {
        searchJob?.cancel()
        _state.update { it.copy(query = query, searching = true) }
        searchJob = scope.launch {
            try {
                val found = api.projectMemory(projectId, query)
                _state.update { current ->
                    // Поле успели переписать, пока искали: чужой ответ не показываем.
                    if (current.query != query) current
                    else current.copy(overview = found, hits = found.hits ?: emptyList(), searching = false, error = null)
                }
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (failure: Throwable) {
                _state.update { current -> if (current.query != query) current else current.copy(searching = false, error = messageOf(failure)) }
            }
        }
    }

    /** Очистка поля: список результатов уходит, обзор памяти остаётся. */
    fun clearSearch() {
        searchJob?.cancel()
        _state.update { it.copy(query = "", hits = null, searching = false) }
    }

    private fun messageOf(failure: Throwable): String =
        (failure as? ApiException)?.error?.message ?: failure.message ?: "Не удалось прочитать память проекта"
}
