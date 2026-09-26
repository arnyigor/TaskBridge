package ru.arny.taskbridge.platform

import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.awt.FileDialog
import java.awt.Frame
import java.io.File

@Composable
internal actual fun rememberImageSaver(name: String, bytes: ByteArray, onResult: (String) -> Unit): () -> Unit {
    val scope = rememberCoroutineScope()
    return {
        val dialog = FileDialog(null as Frame?, "Сохранить изображение", FileDialog.SAVE)
        try {
            dialog.file = name
            dialog.isVisible = true
            val file = dialog.file?.let { File(dialog.directory, it) }
            if (file != null) scope.launch {
                val saved = withContext(Dispatchers.IO) { runCatching { file.writeBytes(bytes) } }
                onResult(saved.fold({ "Сохранено" }, { "Не удалось сохранить: ${it.message}" }))
            }
        } finally {
            dialog.dispose()
        }
    }
}
