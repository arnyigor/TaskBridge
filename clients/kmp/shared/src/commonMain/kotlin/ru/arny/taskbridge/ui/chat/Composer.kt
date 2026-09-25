package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ru.arny.taskbridge.core.api.UploadFile
import ru.arny.taskbridge.platform.rememberClipboardFiles
import kotlinx.coroutines.delay
import ru.arny.taskbridge.core.client.session.SendMode
import ru.arny.taskbridge.core.client.sessions.DisplayState
import ru.arny.taskbridge.ui.common.StatusDot
import ru.arny.taskbridge.ui.common.formatBytes
import ru.arny.taskbridge.ui.theme.AppIcons
import ru.arny.taskbridge.ui.theme.LocalStatusColors
import kotlin.time.Clock

@Composable
fun Composer(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    files: List<UploadFile>,
    onRemoveFile: (UploadFile) -> Unit,
    onAttach: () -> Unit,
    /** Pictures or files from the clipboard (Ctrl+V, «Вставить из буфера»); empty from the menu when it holds none. */
    onPaste: (List<UploadFile>) -> Unit,
    working: Boolean,
    enterSends: Boolean,
    enabled: Boolean,
    onSend: (SendMode) -> Unit,
    modifier: Modifier = Modifier,
    /** When the current run started (epoch ms): the status line counts from it. */
    runStartedAt: Long? = null,
    /** What the agent is doing now ("Running tests…"), from the server. */
    activity: String? = null,
    stopping: Boolean = false,
    onStop: () -> Unit = {},
    /** Above the input: the queue line, outbox problems. */
    top: @Composable () -> Unit = {},
    /** Extra items of the «+» menu (the session's model and context); call `close` on click. */
    moreItems: @Composable (close: () -> Unit) -> Unit = {},
) {
    var modeMenu by remember { mutableStateOf(false) }
    var plusMenu by remember { mutableStateOf(false) }
    val clipboardFiles = rememberClipboardFiles()
    val canSend = enabled && (value.text.isNotBlank() || files.isNotEmpty())
    Surface(modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surface, tonalElevation = 2.dp) {
        // Inside the Surface: its tint runs under the navigation bar instead of a blank strip.
        Column(Modifier.navigationBarsPadding().padding(horizontal = 10.dp, vertical = 8.dp)) {
            if (working) RunStatus(runStartedAt, activity, stopping, onStop)
            top()
            if (files.isNotEmpty()) {
                FlowRow(Modifier.padding(bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (file in files) {
                        InputChip(
                            selected = false,
                            onClick = { onRemoveFile(file) },
                            label = { Text("${file.name} · ${formatBytes(file.bytes.size.toLong())}") },
                            trailingIcon = { Icon(AppIcons.Close, "Убрать", Modifier.size(16.dp)) },
                        )
                    }
                }
            }
            // One capsule: «+», the text (all the free width, grows by itself), send.
            Surface(shape = RoundedCornerShape(24.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
                Row(Modifier.heightIn(min = 52.dp).padding(4.dp), verticalAlignment = Alignment.Bottom) {
                    Box {
                        IconButton(onClick = { plusMenu = true }, enabled = enabled, modifier = Modifier.size(44.dp)) {
                            Icon(AppIcons.Add, "Вложения и действия", Modifier.size(22.dp))
                        }
                        DropdownMenu(expanded = plusMenu, onDismissRequest = { plusMenu = false }) {
                            DropdownMenuItem(
                                text = { Text("Прикрепить файл") },
                                leadingIcon = { Icon(AppIcons.Attach, null) },
                                onClick = { plusMenu = false; onAttach() },
                            )
                            DropdownMenuItem(
                                text = { Text("Вставить из буфера") },
                                leadingIcon = { Icon(AppIcons.Copy, null) },
                                onClick = { plusMenu = false; onPaste(clipboardFiles()) },
                            )
                            moreItems { plusMenu = false }
                        }
                    }
                    BasicTextField(
                        value = value,
                        onValueChange = onValueChange,
                        enabled = enabled,
                        // Grows line by line up to 6 lines, then scrolls inside.
                        maxLines = 6,
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        decorationBox = { field ->
                            Box(contentAlignment = Alignment.CenterStart) {
                                if (value.text.isEmpty()) {
                                    Text(
                                        if (working) "Добавить инструкцию…" else "Сообщение агенту…",
                                        style = MaterialTheme.typography.bodyLarge,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                field()
                            }
                        },
                        modifier = Modifier
                            .weight(1f)
                            .padding(horizontal = 4.dp, vertical = 12.dp)
                            .onPreviewKeyEvent { event ->
                                // Ctrl+V with a picture or files in the clipboard attaches them;
                                // with text it falls through to the field's own paste.
                                if (event.type == KeyEventType.KeyDown && event.key == Key.V && (event.isCtrlPressed || event.isMetaPressed)) {
                                    val pasted = clipboardFiles()
                                    if (pasted.isEmpty()) return@onPreviewKeyEvent false
                                    onPaste(pasted)
                                    return@onPreviewKeyEvent true
                                }
                                if (event.type != KeyEventType.KeyDown || (event.key != Key.Enter && event.key != Key.NumPadEnter)) return@onPreviewKeyEvent false
                                when {
                                    event.isCtrlPressed || event.isMetaPressed -> { if (canSend) onSend(SendMode.NOW); true }
                                    event.isShiftPressed || !enterSends -> {
                                        // A newline at the cursor.
                                        val text = value.text.replaceRange(value.selection.min, value.selection.max, "\n")
                                        onValueChange(TextFieldValue(text, TextRange(value.selection.min + 1)))
                                        true
                                    }
                                    else -> { if (canSend) onSend(SendMode.QUEUE); true }
                                }
                            },
                    )
                    Box {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            // While the agent works: how to send (also a long press on the send button).
                            if (working) {
                                IconButton(onClick = { modeMenu = true }, enabled = canSend, modifier = Modifier.size(36.dp)) {
                                    Icon(AppIcons.ChevronUp, "Как отправить", Modifier.size(22.dp))
                                }
                            }
                            Box(
                                Modifier
                                    .size(44.dp)
                                    .clip(CircleShape)
                                    .background(if (canSend) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f))
                                    .combinedClickable(
                                        enabled = canSend,
                                        onLongClick = if (working) ({ modeMenu = true }) else null,
                                        onClick = { onSend(SendMode.QUEUE) },
                                    ),
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    if (working) AppIcons.Queue else AppIcons.Send,
                                    if (working) "В очередь" else "Отправить",
                                    Modifier.size(22.dp),
                                    tint = if (canSend) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f),
                                )
                            }
                        }
                        DropdownMenu(expanded = modeMenu, onDismissRequest = { modeMenu = false }) {
                            DropdownMenuItem(
                                text = { ModeText("В очередь", "Уйдёт, когда закончится текущий ответ") },
                                leadingIcon = { Icon(AppIcons.Queue, null) },
                                onClick = { modeMenu = false; onSend(SendMode.QUEUE) },
                            )
                            DropdownMenuItem(
                                text = { ModeText("Вклиниться", "Команды не остановятся, агент ответит на это сообщение (Ctrl+Enter)") },
                                leadingIcon = { Icon(AppIcons.Spark, null) },
                                onClick = { modeMenu = false; onSend(SendMode.NOW) },
                            )
                        }
                    }
                }
            }
        }
    }
}

/** "● Работает · 18 с · Running tests…  ■" — the live run and its STOP, right above the input. */
@Composable
private fun RunStatus(startedAt: Long?, activity: String?, stopping: Boolean, onStop: () -> Unit) {
    var now by remember { mutableStateOf(Clock.System.now().toEpochMilliseconds()) }
    LaunchedEffect(startedAt) {
        while (true) {
            now = Clock.System.now().toEpochMilliseconds()
            delay(1000)
        }
    }
    val seconds = startedAt?.let { ((now - it) / 1000).coerceAtLeast(0) }
    val elapsed = seconds?.let { if (it < 60) "$it с" else "${it / 60} мин ${it % 60} с" }
    val color = LocalStatusColors.current.working
    Row(Modifier.fillMaxWidth().padding(start = 6.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        StatusDot(DisplayState.WORKING, size = 8)
        Spacer(Modifier.width(8.dp))
        Text(
            listOfNotNull(if (stopping) "Останавливается" else "Работает", elapsed, activity?.takeIf { it.isNotBlank() && !stopping }).joinToString(" · "),
            style = MaterialTheme.typography.labelMedium,
            color = color,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        IconButton(onClick = onStop, enabled = !stopping, modifier = Modifier.size(36.dp)) {
            if (stopping) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.error)
            else Icon(AppIcons.Stop, "Остановить агента", Modifier.size(16.dp), tint = MaterialTheme.colorScheme.error)
        }
    }
}

@Composable
private fun ModeText(title: String, hint: String) {
    Column {
        Text(title)
        Text(hint, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
