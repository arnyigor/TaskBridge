package ru.arny.taskbridge.core.client.sessions

import ru.arny.taskbridge.core.api.Task

/**
 * One state per session for lists and headers (backend plan 3.1). Until the
 * server sends `displayState` itself, it is derived from `status` here, in one
 * place, the way the plan's legacy mapping says.
 */
enum class DisplayState(val label: String, val order: Int) {
    WAITING_USER("Ждёт ответа", 0),
    WORKING("Работает", 1),
    QUEUED("В очереди", 2),
    RESTORABLE("Прервана — можно продолжить", 3),
    FAILED("Ошибка", 4),
    CANCELLED("Остановлена", 5),
    DONE("Готово", 6),
    UNKNOWN("—", 7);

    val active: Boolean get() = this == WAITING_USER || this == WORKING || this == QUEUED
}

fun displayStateOf(task: Task): DisplayState = when (task.status) {
    "WAITING_USER" -> DisplayState.WAITING_USER
    "PREPARING", "PREFLIGHT", "RUNNING", "VERIFYING", "CANCELLING" -> DisplayState.WORKING
    "QUEUED" -> DisplayState.QUEUED
    "SUCCEEDED" -> DisplayState.DONE
    "CANCELLED" -> DisplayState.CANCELLED
    // The daemon or Pi went away mid-turn: the next message resumes the session.
    "FAILED" -> if (task.errorCode == "FAILED_RECOVERY" || task.errorCode == "PI_SESSION_FAILED") DisplayState.RESTORABLE else DisplayState.FAILED
    else -> DisplayState.UNKNOWN
}

/** What the session is doing right now, for the second line of a list row. */
fun activityOf(task: Task): String? {
    val state = displayStateOf(task)
    return when {
        state == DisplayState.QUEUED -> when (task.queueReason) {
            "MODEL_BUSY" -> "Ждёт освобождения модели"
            "MODEL_LOADING" -> "Ждёт загрузки модели"
            "BUSY" -> "Ждёт, пока закончится другая сессия"
            "RESTORED" -> "В очереди после перезапуска"
            else -> task.current ?: "В очереди"
        }
        state.active -> task.current
        state == DisplayState.FAILED || state == DisplayState.RESTORABLE -> task.error
        else -> null
    }
}
