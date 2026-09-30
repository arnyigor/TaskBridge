package ru.arny.taskbridge

import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import org.jetbrains.skia.Image
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.type
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Notification
import androidx.compose.ui.window.Tray
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberTrayState
import androidx.compose.ui.window.rememberWindowState
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flowOf
import ru.arny.taskbridge.core.client.sessions.SessionAlert
import ru.arny.taskbridge.core.client.sessions.SessionListState
import ru.arny.taskbridge.platform.DesktopPlatformServices
import ru.arny.taskbridge.ui.Navigator
import ru.arny.taskbridge.ui.theme.AppIcons
import java.awt.event.WindowAdapter
import java.awt.event.WindowEvent

fun main() {
    // A second launch brings the running window forward instead of starting another tray instance.
    if (!SingleInstance.claimPrimary()) {
        SingleInstance.activateExisting()
        return
    }
    val showRequests = MutableStateFlow(0)
    SingleInstance.listen { showRequests.value += 1 }
    val packagedVersion = object {}.javaClass.getResourceAsStream("/taskbridge-version.txt")
        ?.bufferedReader()?.use { it.readText().trim() }.orEmpty()
    val platform = DesktopPlatformServices(appVersion = packagedVersion)
    val graph = AppGraph(platform)

    application {
        var visible by remember { mutableStateOf(true) }
        var navigator by remember { mutableStateOf<Navigator?>(null) }
        val trayState = rememberTrayState()
        val alerts = remember { Channel<SessionAlert>(Channel.BUFFERED) }
        // The session the window opens on: the last one seen. Alerts no longer take the
        // screen anywhere — they pulse the row in the list instead.
        val startTaskId = remember { graph.settings.lastSessionId }
        val connection = graph.connection
        val listState by (connection?.sessions?.state ?: flowOf(SessionListState())).collectAsState(SessionListState())
        val shows by showRequests.collectAsState()
        LaunchedEffect(shows) { if (shows > 0) visible = true }

        // Alerts may come from background client coroutines. Hop through the Compose coroutine
        // before touching TrayState/AWT; otherwise desktop notifications can crash the app.
        DisposableEffect(alerts) {
            platform.notifier = { alert: SessionAlert -> alerts.trySend(alert) }
            onDispose { platform.notifier = null }
        }
        LaunchedEffect(alerts) {
            for (alert in alerts) {
                runCatching {
                    trayState.sendNotification(
                        Notification(
                            alertTitle(alert),
                            alert.text,
                            if (alert.kind == SessionAlert.Kind.WAITING_USER) Notification.Type.Warning else Notification.Type.Info,
                        ),
                    )
                }
                // The screen is never taken away: an alert only pulses the session row in the
                // list, so reading another chat or typing is never interrupted.
            }
        }

        val summary = buildList {
            if (listState.waitingCount > 0) add("ждут ответа: ${listState.waitingCount}")
            if (listState.workingCount > 0) add("работают: ${listState.workingCount}")
        }.joinToString(", ").ifEmpty { "агент свободен" }

        // The brand mark (web/icon.svg, rendered by icons/make-icon.ps1): the old line icon was black on a dark taskbar.
        val appIcon = remember { BitmapPainter(Image.makeFromEncoded(object {}.javaClass.getResourceAsStream("/icon.png")!!.readBytes()).toComposeImageBitmap()) }
        Tray(
            icon = if (listState.waitingCount > 0) rememberVectorPainter(AppIcons.Alert) else appIcon,
            state = trayState,
            tooltip = "TaskBridge — $summary",
            onAction = { visible = true },
            menu = {
                Item("Открыть TaskBridge", onClick = { visible = true })
                Item(summary, enabled = false, onClick = {})
                val installDir = DesktopUpdater.installDir()
                val staged = installDir?.let { DesktopUpdater.stagedUpdate(it) }
                if (installDir != null && staged != null) {
                    Separator()
                    Item("Установить обновление и перезапустить", onClick = {
                        if (DesktopUpdater.applyAndRestart(installDir, staged)) exitApplication()
                    })
                }
                Separator()
                Item("Выход", onClick = ::exitApplication)
            },
        )

        val settings = graph.settings
        val windowState = rememberWindowState(
            size = DpSize(
                (platform.store.get("window.width")?.toFloatOrNull() ?: 1180f).dp,
                (platform.store.get("window.height")?.toFloatOrNull() ?: 820f).dp,
            ),
        )
        LaunchedEffect(windowState) {
            snapshotFlow { windowState.size }.collect { size ->
                platform.store.put("window.width", size.width.value.toString())
                platform.store.put("window.height", size.height.value.toString())
            }
        }

        Window(
            // Closing the window quits: hiding to the tray left processes nobody knew were running.
            onCloseRequest = ::exitApplication,
            visible = visible,
            state = windowState,
            title = "TaskBridge",
            icon = appIcon,
            onPreviewKeyEvent = { event ->
                if (event.type == KeyEventType.KeyDown && event.key == Key.Escape) navigator?.pop() ?: false else false
            },
        ) {
            // Another launch asked for this window: out of the tray / minimized, to the front.
            LaunchedEffect(shows) {
                if (shows > 0) {
                    window.isMinimized = false
                    window.toFront()
                    window.requestFocus()
                }
            }
            LaunchedEffect(window) {
                window.addWindowFocusListener(object : WindowAdapter() {
                    override fun windowGainedFocus(e: WindowEvent?) {
                        platform.foreground = true
                        graph.connection?.wakeUp()
                    }

                    override fun windowLostFocus(e: WindowEvent?) {
                        platform.foreground = false
                    }
                })
            }
            LaunchedEffect(visible) { if (!visible) platform.foreground = false }
            App(graph, openTaskId = startTaskId, navigatorSink = { navigator = it })
        }
    }
}
