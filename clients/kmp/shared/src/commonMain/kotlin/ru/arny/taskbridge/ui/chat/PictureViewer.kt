package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import ru.arny.taskbridge.platform.rememberImageSaver

/** Separate from the scrolling file sheet so image gestures cannot drag the sheet. */
@Composable
internal fun PictureViewer(bitmap: ImageBitmap, original: ByteArray, name: String, onDismiss: () -> Unit) {
    var scale by remember(bitmap) { mutableStateOf(1f) }
    var offset by remember(bitmap) { mutableStateOf(Offset.Zero) }
    var notice by remember(bitmap) { mutableStateOf<String?>(null) }
    val save = rememberImageSaver(name, original) { notice = it }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().safeDrawingPadding()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(name, Modifier.weight(1f), maxLines = 1)
                    TextButton(onClick = onDismiss) { Text("Закрыть") }
                }
                BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().clipToBounds()) {
                    val density = androidx.compose.ui.platform.LocalDensity.current
                    val width = with(density) { maxWidth.toPx() }
                    val height = with(density) { maxHeight.toPx() }
                    val fit = minOf(width / bitmap.width, height / bitmap.height)
                    fun constrain(value: Offset, zoom: Float): Offset {
                        val x = ((bitmap.width * fit * zoom - width) / 2).coerceAtLeast(0f)
                        val y = ((bitmap.height * fit * zoom - height) / 2).coerceAtLeast(0f)
                        return Offset(value.x.coerceIn(-x, x), value.y.coerceIn(-y, y))
                    }
                    Image(bitmap, name, Modifier.fillMaxSize()
                        .pointerInput(bitmap, width, height) {
                            detectTransformGestures { centroid, pan, zoom, _ ->
                                val next = (scale * zoom).coerceIn(1f, 8f)
                                val focus = centroid - Offset(width / 2, height / 2)
                                offset = constrain(focus - (focus - offset) * (next / scale) + pan, next)
                                scale = next
                            }
                        }
                        .graphicsLayer {
                            scaleX = scale
                            scaleY = scale
                            translationX = offset.x
                            translationY = offset.y
                        }, contentScale = ContentScale.Fit)
                }
                notice?.let { Text(it, Modifier.padding(horizontal = 12.dp), style = MaterialTheme.typography.bodySmall) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                    TextButton(onClick = { scale = 1f; offset = Offset.Zero }) { Text("Вписать") }
                    TextButton(onClick = { scale = (scale * 2f).coerceAtMost(8f) }) { Text("+ ${(scale * 100).toInt()}%") }
                    TextButton(onClick = save) { Text("Скачать") }
                }
            }
        }
    }
}
