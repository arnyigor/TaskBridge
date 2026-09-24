package ru.arny.taskbridge

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import ru.arny.taskbridge.core.client.sessions.SessionAlert
import ru.arny.taskbridge.platform.PlatformBackHandler
import ru.arny.taskbridge.ui.Navigator
import ru.arny.taskbridge.ui.Screen
import ru.arny.taskbridge.ui.chat.ChatScreen
import ru.arny.taskbridge.ui.chat.DraftChatScreen
import ru.arny.taskbridge.ui.common.EmptyState
import ru.arny.taskbridge.ui.connect.ConnectScreen
import ru.arny.taskbridge.ui.sessions.SessionsScreen
import ru.arny.taskbridge.ui.settings.SettingsScreen
import ru.arny.taskbridge.ui.theme.AppIcons
import ru.arny.taskbridge.ui.theme.TaskBridgeTheme

/**
 * The whole app. [openTaskId] opens a session on start (a tapped
 * notification); [navigatorSink] hands the navigator to the host (desktop
 * shortcuts, deep links).
 */
@Composable
fun App(graph: AppGraph, openTaskId: String? = null, navigatorSink: (Navigator) -> Unit = {}) {
    TaskBridgeTheme(graph.theme) {
        val connection = graph.connection
        val navigator = remember(connection?.baseUrl) {
            Navigator(if (connection == null) Screen.Connect else Screen.Sessions).also(navigatorSink)
        }
        LaunchedEffect(openTaskId, connection) {
            if (connection != null && openTaskId != null) navigator.openChat(openTaskId)
        }
        PlatformBackHandler(enabled = navigator.canPop) { navigator.pop() }
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            if (connection == null) {
                ConnectScreen(graph, onConnected = { navigator.reset(Screen.Sessions) })
            } else {
                BoxWithConstraints(Modifier.fillMaxSize()) {
                    val wide = maxWidth >= 840.dp
                    if (wide) WideLayout(graph, connection, navigator) else NarrowLayout(graph, connection, navigator)
                }
            }
        }
    }
}

/** Phone: one screen at a time. */
@Composable
private fun NarrowLayout(graph: AppGraph, connection: AppGraph.Connected, navigator: Navigator) {
    when (val screen = navigator.current) {
        Screen.Connect, Screen.Sessions -> SessionsScreen(
            graph, connection,
            selectedTaskId = null,
            onOpen = { navigator.openChat(it) },
            onDraft = { navigator.openDraft(it) },
            onSettings = { navigator.push(Screen.Settings) },
        )
        is Screen.Chat -> ChatScreen(
            graph, connection, screen.taskId,
            onBack = { navigator.pop() },
            onOpenSession = { navigator.openChat(it) },
            showBack = true,
        )
        is Screen.Draft -> DraftChatScreen(
            graph, connection, screen.draft,
            onBack = { navigator.pop() },
            onCreated = { navigator.openChat(it) },
            showBack = true,
        )
        Screen.Settings -> SettingsScreen(graph, connection, onBack = { navigator.pop() }, onDisconnected = { navigator.reset(Screen.Connect) })
    }
}

/** Desktop and tablets: the list stays on the left, the chat on the right. */
@Composable
private fun WideLayout(graph: AppGraph, connection: AppGraph.Connected, navigator: Navigator) {
    val open = navigator.stack.lastOrNull { it is Screen.Chat || it is Screen.Draft }
    val chat = open as? Screen.Chat
    val settingsOpen = navigator.current == Screen.Settings
    Row(Modifier.fillMaxSize()) {
        Box(Modifier.width(360.dp).fillMaxHeight()) {
            SessionsScreen(
                graph, connection,
                selectedTaskId = chat?.taskId,
                onOpen = { navigator.openChat(it) },
                onDraft = { navigator.openDraft(it) },
                onSettings = { navigator.push(Screen.Settings) },
            )
        }
        VerticalDivider()
        Box(Modifier.weight(1f).fillMaxHeight()) {
            when {
                settingsOpen -> SettingsScreen(graph, connection, onBack = { navigator.pop() }, onDisconnected = { navigator.reset(Screen.Connect) })
                chat != null -> ChatScreen(
                    graph, connection, chat.taskId,
                    onBack = { navigator.pop() },
                    onOpenSession = { navigator.openChat(it) },
                    showBack = false,
                )
                open is Screen.Draft -> DraftChatScreen(
                    graph, connection, open.draft,
                    onBack = { navigator.pop() },
                    onCreated = { navigator.openChat(it) },
                    showBack = false,
                )
                else -> EmptyState(AppIcons.Chat, "Выберите сессию", "Слева — все сессии агента на этом компьютере. Или начните новую.")
            }
        }
    }
}

/** Title for a system notification about [alert]. */
fun alertTitle(alert: SessionAlert): String = when (alert.kind) {
    SessionAlert.Kind.WAITING_USER -> "Ждёт ответа"
    SessionAlert.Kind.FINISHED -> "Готово"
    SessionAlert.Kind.FAILED -> "Ошибка"
} + " · " + alert.title
