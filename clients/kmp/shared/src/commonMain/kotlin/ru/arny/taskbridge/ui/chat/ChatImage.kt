package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.decodeToImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

private val IMAGE_EXT = Regex("\\.(png|jpe?g|gif|webp|bmp)$", RegexOption.IGNORE_CASE)

internal fun isImageName(name: String?): Boolean = name != null && IMAGE_EXT.containsMatchIn(name)

internal fun decodeImage(bytes: ByteArray): ImageBitmap? = runCatching { bytes.decodeToImageBitmap() }.getOrNull()

/**
 * A picture in the conversation, read through the API. A file that cannot be
 * read or decoded shows nothing (the file chip stays) — like the web client,
 * which withdraws a broken preview instead of showing a broken icon.
 */
@Composable
fun ChatImage(key: String, name: String, load: suspend () -> Result<ByteArray>, onClick: () -> Unit, modifier: Modifier = Modifier) {
    // ponytail: no cache — a picture scrolled out of the list is read again; add an LRU if chats get image-heavy.
    val bitmap by produceState<ImageBitmap?>(null, key) { value = load().getOrNull()?.let(::decodeImage) }
    bitmap?.let {
        Image(
            it,
            contentDescription = name,
            contentScale = ContentScale.Fit,
            modifier = modifier.pictureBox(it.width, it.height).clip(RoundedCornerShape(12.dp)).clickable(onClick = onClick),
        )
    }
}

/**
 * Scaled up to the box (a 96-px icon would otherwise be a dot), within 320×240 dp.
 * No fillMaxWidth: pinning the width left a tall picture no height that fit, so
 * it was laid out taller than its slot and drew over the text around it.
 */
internal fun Modifier.pictureBox(width: Int, height: Int): Modifier =
    widthIn(max = 320.dp).heightIn(max = 240.dp).aspectRatio(width.toFloat() / height.coerceAtLeast(1))

/**
 * Скриншот агента (Blender и любой другой инструмент) свёрнут в одну строку:
 * за один ход их бывает десяток, и развёрнутые они вытесняют сам ответ.
 * Тап по строке раскрывает картинку на месте — тот же ChatImage, что и раньше.
 */
@Composable
fun ChatImageSpoiler(
    key: String,
    name: String,
    load: suspend () -> Result<ByteArray>,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    initiallyOpen: Boolean = false,
) {
    var open by remember(key) { mutableStateOf(initiallyOpen) }
    Column(modifier) {
        Text(
            text = if (open) "▾ 🖼 $name" else "▸ 🖼 $name",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.clip(RoundedCornerShape(999.dp)).clickable { open = !open }.padding(horizontal = 8.dp, vertical = 4.dp),
        )
        if (open) ChatImage(key, name, load, onClick, Modifier.padding(top = 4.dp))
    }
}
