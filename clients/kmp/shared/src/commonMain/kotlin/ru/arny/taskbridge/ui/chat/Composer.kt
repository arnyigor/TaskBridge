package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
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
import androidx.compose.ui.unit.dp
import ru.arny.taskbridge.core.api.UploadFile
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
    working: Boolean,
    enterSends: Boolean,
    enabled: Boolean,
    onSend: (SendMode) -> Unit,
    modifier: Modifier = Modifier,
) {
    var modeMenu by remember { mutableStateOf(false) }
    val canSend = enabled && (value.text.isNotBlank() || files.isNotEmpty())
    Surface(modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surface, tonalElevation = 2.dp) {
        Column(Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) {
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
            Row(verticalAlignment = Alignment.Bottom) {
                IconButton(onClick = onAttach, enabled = enabled) { Icon(AppIcons.Attach, "Прикрепить файл") }
                TextField(
                    value = value,
                    onValueChange = onValueChange,
                    enabled = enabled,
                    placeholder = { Text(if (working) "Уточнить или поставить в очередь…" else "Сообщение агенту…") },
                    maxLines = 8,
                    shape = RoundedCornerShape(22.dp),
                    colors = TextFieldDefaults.colors(
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                        disabledIndicatorColor = Color.Transparent,
                        focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                        unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                    ),
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = 48.dp)
                        .onPreviewKeyEvent { event ->
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
                Spacer(Modifier.width(6.dp))
                Box {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (working) {
                            IconButton(onClick = { modeMenu = true }, enabled = canSend, modifier = Modifier.size(32.dp)) {
                                Icon(AppIcons.ChevronUp, "Как отправить", Modifier.size(18.dp))
                            }
                        }
                        FilledIconButton(
                            onClick = { onSend(SendMode.QUEUE) },
                            enabled = canSend,
                            modifier = Modifier.size(48.dp),
                            colors = IconButtonDefaults.filledIconButtonColors(),
                        ) {
                            Icon(if (working) AppIcons.Queue else AppIcons.Send, if (working) "В очередь" else "Отправить")
                        }
                    }
                    DropdownMenu(expanded = modeMenu, onDismissRequest = { modeMenu = false }) {
                        DropdownMenuItem(
                            text = { ModeText("В очередь", "Уйдёт, когда закончится текущий ответ") },
                            leadingIcon = { Icon(AppIcons.Queue, null) },
                            onClick = { modeMenu = false; onSend(SendMode.QUEUE) },
                        )
                        DropdownMenuItem(
                            text = { ModeText("Вклиниться", "Подсказка в текущий ответ, без остановки") },
                            leadingIcon = { Icon(AppIcons.Spark, null) },
                            onClick = { modeMenu = false; onSend(SendMode.STEER) },
                        )
                        DropdownMenuItem(
                            text = { ModeText("Прервать и отправить", "Остановит ответ и запущенные команды (Ctrl+Enter)") },
                            leadingIcon = { Icon(AppIcons.Stop, null) },
                            onClick = { modeMenu = false; onSend(SendMode.NOW) },
                        )
                    }
                }
            }
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
