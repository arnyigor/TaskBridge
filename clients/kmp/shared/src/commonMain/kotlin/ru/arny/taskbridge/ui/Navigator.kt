package ru.arny.taskbridge.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.Saver
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import ru.arny.taskbridge.core.api.ModelRef

@Serializable
sealed interface Screen {
    @Serializable
    data object Connect : Screen

    /**
     * The session list. [projectId] narrows it to one project — that is how the
     * project dashboard drills into its own sessions (MR-01), and the filter
     * lives on the stack entry so «back» returns to the dashboard.
     */
    @Serializable
    data class Sessions(val projectId: String? = null) : Screen

    /** The project dashboard: every project, its sessions, pinned and archived. */
    @Serializable
    data object Projects : Screen
    /** One project's operational memory: Work Items, sessions and recurring work. */
    @Serializable
    data class Project(val projectId: String) : Screen

    @Serializable
    data class Chat(val taskId: String) : Screen
    /** A new session not yet on the PC: it is created by its first message. */
    @Serializable
    data class Draft(val draft: SessionDraft) : Screen
    @Serializable
    data object Settings : Screen
    /** Управление локальными моделями: рабочий экран, а не настройка. */
    @Serializable
    data object LocalModels : Screen
    /** Процессы машины с сервером: список, память и kill. */
    @Serializable
    data object Processes : Screen
}

/** A plain back stack: the app has four screens, a library would add more than it saves. */
class Navigator(start: Screen) {
    companion object {
        /** Save route IDs, never a connection, loaded history or runtime state. */
        fun saver(connectionKey: String?, start: Screen): Saver<Navigator, List<String>> = Saver(
            save = { listOf(connectionKey.orEmpty(), Json.encodeToString(it.stack)) },
            restore = { saved ->
                val screens = if (saved.firstOrNull() == connectionKey.orEmpty()) {
                    runCatching { Json.decodeFromString<List<Screen>>(saved[1]) }.getOrNull()
                } else null
                Navigator(start).apply { if (!screens.isNullOrEmpty()) stack = screens }
            },
        )
    }

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
@Serializable
data class SessionDraft(
    val projectId: String,
    val projectName: String,
    val model: ModelRef?,
    val thinking: String?,
    val title: String?,
    val commandId: String,
)
