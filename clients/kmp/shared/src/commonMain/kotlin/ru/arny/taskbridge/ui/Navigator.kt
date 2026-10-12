package ru.arny.taskbridge.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ru.arny.taskbridge.core.api.ModelRef

sealed interface Screen {
    data object Connect : Screen

    /**
     * The session list. [projectId] narrows it to one project — that is how the
     * project dashboard drills into its own sessions (MR-01), and the filter
     * lives on the stack entry so «back» returns to the dashboard.
     */
    data class Sessions(val projectId: String? = null) : Screen

    /** The project dashboard: every project, its sessions, pinned and archived. */
    data object Projects : Screen
    /** One project's operational memory: Work Items, sessions and recurring work. */
    data class Project(val projectId: String) : Screen

    data class Chat(val taskId: String) : Screen
    /** A new session not yet on the PC: it is created by its first message. */
    data class Draft(val draft: SessionDraft) : Screen
    data object Settings : Screen
    /** Управление локальными моделями: рабочий экран, а не настройка. */
    data object LocalModels : Screen
    /** Процессы машины с сервером: список, память и kill. */
    data object Processes : Screen
}

/** A plain back stack: the app has four screens, a library would add more than it saves. */
class Navigator(start: Screen) {
    var stack: List<Screen> by mutableStateOf(listOf(start))
        private set

    val current: Screen get() = stack.last()
    val canPop: Boolean get() = stack.size > 1

    fun push(screen: Screen) {
        if (current != screen) stack = stack + screen
    }

    fun pop(): Boolean {
        if (!canPop) return false
        stack = stack.dropLast(1)
        return true
    }

    fun reset(screen: Screen) {
        stack = listOf(screen)
    }

    /** Opens a chat on top of the list, replacing another open chat. */
    fun openChat(taskId: String) {
        val base = stack.filterNot { it is Screen.Chat || it is Screen.Draft || it is Screen.Settings }
        stack = base + Screen.Chat(taskId)
    }

    /** One project dashboard, replacing another project dashboard. */
    fun openProject(projectId: String) {
        val base = stack.filterNot { it is Screen.Project }
        stack = base + Screen.Project(projectId)
    }

    /** Sessions are one level below the project dashboard, so Back returns to it. */
    fun openProjectSessions(projectId: String) {
        push(Screen.Sessions(projectId))
    }

    fun openDraft(draft: SessionDraft) {
        val base = stack.filterNot { it is Screen.Chat || it is Screen.Draft || it is Screen.Settings }
        stack = base + Screen.Draft(draft)
    }
}

/**
 * What the new-session sheet chose when no task was typed yet. The server
 * starts Pi as it creates a session, so an empty session cannot exist there;
 * the draft waits in the app until the first message.
 */
data class SessionDraft(
    val projectId: String,
    val projectName: String,
    val model: ModelRef?,
    val thinking: String?,
    val title: String?,
    val commandId: String,
)
