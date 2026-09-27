package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
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
import ru.arny.taskbridge.core.client.session.SendMode
import ru.arny.taskbridge.ui.common.formatBytes
import ru.arny.taskbridge.ui.theme.AppIcons

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
    onStop: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
    /** Above the input: the queue line, outbox problems. */
    top: @Composable () -> Unit = {},
    /** Extra items of the actions menu (the session's model and context); call `close` on click. */
    moreItems: @Composable (close: () -> Unit) -> Unit = {},
) {
    var actionsMenu by remember { mutableStateOf(false) }
    var focused by remember { mutableStateOf(false) }
    val clipboardFiles = rememberClipboardFiles()
    val canSend = enabled && (value.text.isNotBlank() || files.isNotEmpty())
    val canStop = onStop != null
    Surface(modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surface, tonalElevation = 2.dp) {
        // Inside the Surface: its tint runs under the navigation bar instead of a blank strip.
        Column(Modifier.navigationBarsPadding().padding(horizontal = 10.dp, vertical = 8.dp)) {
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
            // One card: the message on top, the actions under it. The border lights
            // up while the field has focus, so it is clear where the text goes.
            Surface(
                shape = RoundedCornerShape(16.dp),
                color = MaterialTheme.colorScheme.surfaceContainerLowest,
                border = BorderStroke(
                    1.dp,
                    if (focused) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
                ),
            ) {
                Column(Modifier.padding(6.dp)) {
                    Box(Modifier.fillMaxWidth()) {
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
                                .fillMaxWidth()
                                .padding(
                                    start = 12.dp,
                                    end = if (value.text.isNotEmpty()) 48.dp else 12.dp,
                                    top = 8.dp,
                                    bottom = 8.dp,
                                )
                                .onFocusChanged { focused = it.isFocused }
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
                        if (value.text.isNotEmpty()) {
                            IconButton(
                                onClick = { onValueChange(TextFieldValue("")) },
                                enabled = enabled,
                                modifier = Modifier.align(Alignment.TopEnd).size(40.dp),
                            ) {
                                Icon(AppIcons.Close, "Очистить текст", Modifier.size(18.dp))
                            }
                        }
                    }
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconButton(onClick = onAttach, enabled = enabled, modifier = Modifier.size(40.dp)) {
                            Icon(AppIcons.Attach, "Прикрепить файл", Modifier.size(20.dp))
                        }
                        Box {
                            IconButton(onClick = { actionsMenu = true }, enabled = enabled, modifier = Modifier.size(40.dp)) {
                                Icon(AppIcons.Tool, "Действия и буфер обмена", Modifier.size(20.dp))
                            }
                            DropdownMenu(expanded = actionsMenu, onDismissRequest = { actionsMenu = false }) {
                                DropdownMenuItem(
                                    text = { Text("Прикрепить файл") },
                                    leadingIcon = { Icon(AppIcons.Attach, null) },
                                    onClick = { actionsMenu = false; onAttach() },
                                )
                                DropdownMenuItem(
                                    text = { Text("Вставить из буфера") },
                                    leadingIcon = { Icon(AppIcons.Copy, null) },
                                    onClick = { actionsMenu = false; onPaste(clipboardFiles()) },
                                )
                                moreItems { actionsMenu = false }
                            }
                        }
                        Spacer(Modifier.weight(1f))
                        // The lightning cuts into a running turn, so it only has a job while one is
                        // going: with the agent idle the plane is the whole story.
                        if (working) {
                            SquareButton(
                                icon = AppIcons.Spark,
                                description = "Вклиниться сейчас",
                                enabled = canSend,
                                background = MaterialTheme.colorScheme.primaryContainer,
                                content = MaterialTheme.colorScheme.onPrimaryContainer,
                                onClick = { onSend(SendMode.NOW) },
                            )
                        }
                        SquareButton(
                            icon = AppIcons.Send,
                            description = "Отправить в очередь",
                            enabled = canSend,
                            background = MaterialTheme.colorScheme.primary,
                            content = MaterialTheme.colorScheme.onPrimary,
                            onClick = { onSend(SendMode.QUEUE) },
                        )
                        // Stop is always in place: a button that appears and disappears
                        // confuses more than a disabled one.
                        SquareButton(
                            icon = AppIcons.Stop,
                            description = "Остановить агента",
                            enabled = canStop,
                            background = MaterialTheme.colorScheme.errorContainer,
                            content = MaterialTheme.colorScheme.error,
                            onClick = { onStop?.invoke() },
                        )
                    }
                }
            }
        }
    }
}

/** Send, «вклиниться» and stop: the same rounded square, told apart by colour alone. */
@Composable
private fun SquareButton(
    icon: ImageVector,
    description: String,
    enabled: Boolean,
    background: Color,
    content: Color,
    onClick: () -> Unit,
) {
    Box(
        Modifier
            .size(40.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(if (enabled) background else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            icon,
            description,
            Modifier.size(20.dp),
            tint = if (enabled) content else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f),
        )
    }
}
