package ru.arny.taskbridge

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogWindow
import androidx.compose.ui.window.WindowPosition
import androidx.compose.ui.window.rememberDialogState
import kotlinx.coroutines.delay
import ru.arny.taskbridge.core.client.sessions.SessionAlert
import ru.arny.taskbridge.ui.notice.SessionNoticeCard
import ru.arny.taskbridge.ui.notice.noticeHeight
import ru.arny.taskbridge.ui.theme.TaskBridgeTheme

/** Сколько карточка висит на экране, пока её не нажмут. */
const val NOTICE_MILLIS = 15_000L

private val CARD_GAP = 8.dp

/**
 * Уведомление — своё окно, а не системный тост. Системный тост на Windows
 * доставлен быть не может: Compose отдаёт его через AWT TrayIcon.displayMessage,
 * у которого нет обработчика клика — нажатие уходило в пустоту. Карточку мы
 * рисуем сами, поэтому клик открывает чат её сессии, а окно не забирает фокус
 * (печатать в другом приложении уведомление не мешает).
 */
@Composable
fun SessionNoticeWindow(
    notices: List<SessionAlert>,
    theme: String,
    onOpen: (String) -> Unit,
    onDismiss: (String) -> Unit,
) {
    if (notices.isEmpty()) return
    // Окно ровно по карточкам: прозрачное поле вокруг них съедало бы клики по чужим окнам.
    val height = CARD_GAP * 2 +
        notices.fold(0.dp) { sum, alert ->
            sum + noticeHeight(alertTitle(alert), alert.text) + CARD_GAP
        } - CARD_GAP
    val state = rememberDialogState(size = DpSize(420.dp, height), position = WindowPosition(Alignment.BottomEnd))
    DialogWindow(
        onCloseRequest = { notices.forEach { onDismiss(it.taskId) } },
        state = state,
        visible = true,
        title = "TaskBridge",
        undecorated = true,
        transparent = true,
        resizable = false,
        focusable = false,
        alwaysOnTop = true,
    ) {
        TaskBridgeTheme(theme) {
            Column(
                Modifier.padding(CARD_GAP),
                verticalArrangement = Arrangement.spacedBy(CARD_GAP),
            ) {
                for (alert in notices) {
                    LaunchedEffect(alert.taskId) {
                        delay(NOTICE_MILLIS)
                        onDismiss(alert.taskId)
                    }
                    SessionNoticeCard(
                        alert = alert,
                        onOpen = onOpen,
                        modifier = Modifier.fillMaxWidth().height(noticeHeight(alertTitle(alert), alert.text)),
                    )
                }
            }
        }
    }
}
