package ru.arny.taskbridge.platform

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
internal actual fun rememberImageSaver(name: String, bytes: ByteArray, onResult: (String) -> Unit): () -> Unit {
    val resolver = LocalContext.current.contentResolver
    val scope = rememberCoroutineScope()
    val result by rememberUpdatedState(onResult)
    var busy by remember { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("image/*")) { uri ->
        if (uri == null) {
            busy = false
        } else scope.launch {
            try {
                val saved = withContext(Dispatchers.IO) {
                    runCatching {
                        checkNotNull(resolver.openOutputStream(uri)) { "Не удалось открыть файл" }.use { it.write(bytes) }
                    }
                }
                result(saved.fold({ "Сохранено" }, { "Не удалось сохранить: ${it.message}" }))
            } finally {
                busy = false
            }
        }
    }
    return {
        if (!busy) {
            busy = true
            try { launcher.launch(name) } catch (e: Exception) {
                busy = false
                result("Не удалось открыть сохранение: ${e.message}")
            }
        }
    }
}
