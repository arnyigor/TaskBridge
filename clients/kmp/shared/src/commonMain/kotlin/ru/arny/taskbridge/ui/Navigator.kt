package ru.arny.taskbridge.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

sealed interface Screen {
    data object Connect : Screen
    data object Sessions : Screen
    data class Chat(val taskId: String) : Screen
    data object Settings : Screen
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
        val base = stack.filterNot { it is Screen.Chat || it is Screen.Settings }
        stack = base + Screen.Chat(taskId)
    }
}
