package ru.arny.taskbridge.core.client.sessions

import ru.arny.taskbridge.core.api.Task

/** Something the operator should hear about while not looking at the session. */
data class SessionAlert(val taskId: String, val kind: Kind, val title: String, val text: String) {
    enum class Kind { WAITING_USER, FINISHED, FAILED }

    /** One notification per session: a newer alert replaces the older one. */
    val key: String get() = "session:$taskId"
}

/**
 * Compares two consecutive lists and reports transitions only (KMP plan K7:
 * no spam on frequent polls). The first list seen is a baseline and alerts
 * nothing, so opening the app does not replay old news.
 */
class SessionAlerts {
    private var previous: Map<String, DisplayState>? = null

    fun update(tasks: List<Task>): List<SessionAlert> {
        val now = tasks.associate { it.id to displayStateOf(it) }
        val before = previous
        previous = now
        if (before == null) return emptyList()
        return tasks.mapNotNull { task ->
            val was = before[task.id] ?: return@mapNotNull null
            val state = now.getValue(task.id)
            if (was == state) return@mapNotNull null
            val title = task.displayTitle
            when {
                state == DisplayState.WAITING_USER ->
                    SessionAlert(task.id, SessionAlert.Kind.WAITING_USER, title, task.current ?: "Нужен ваш ответ")
                was.active && state == DisplayState.DONE ->
                    SessionAlert(task.id, SessionAlert.Kind.FINISHED, title, task.assistantText?.lineSequence()?.lastOrNull { it.isNotBlank() }?.take(200) ?: "Готово")
                was.active && (state == DisplayState.FAILED || state == DisplayState.RESTORABLE) ->
                    SessionAlert(task.id, SessionAlert.Kind.FAILED, title, task.error ?: "Ход завершился ошибкой")
                else -> null
            }
        }
    }
}
