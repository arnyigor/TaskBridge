package ru.arny.taskbridge.ui.sessions

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ru.arny.taskbridge.core.api.Project
import ru.arny.taskbridge.core.api.ProjectFolderListing
import ru.arny.taskbridge.core.client.sessions.SessionList
import ru.arny.taskbridge.ui.common.AdaptiveSheet
import ru.arny.taskbridge.ui.theme.AppIcons

/** Browses folders on the Pi server, so the chosen path works even from a remote client. */
@Composable
fun ProjectBrowserSheet(sessions: SessionList, onDismiss: () -> Unit, onRegistered: (Project) -> Unit) {
    val scope = rememberCoroutineScope()
    var listing by remember { mutableStateOf<ProjectFolderListing?>(null) }
    var loading by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var name by remember { mutableStateOf("") }

    fun open(path: String?) {
        loading = true
        error = null
        scope.launch {
            sessions.projectFolders(path)
                .onSuccess { listing = it; name = it.path?.trimEnd('/', '\\')?.substringAfterLast('/')?.substringAfterLast('\\').orEmpty() }
                .onFailure { error = it.message ?: "Не удалось открыть папку" }
            loading = false
        }
    }

    LaunchedEffect(Unit) { open(null) }
    AdaptiveSheet(
        title = "Добавить папку проекта",
        subtitle = "Папки на компьютере, где работает сервер TaskBridge",
        onDismiss = onDismiss,
        maxWidth = 620,
        pinned = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(listing?.path ?: "Разрешённые папки", style = MaterialTheme.typography.bodyMedium)
                if (listing?.path != null) {
                    OutlinedTextField(name, { name = it }, label = { Text("Название проекта") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                }
                if (error != null) Text(error.orEmpty(), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
        },
        lazyContent = {
            if (loading) item(key = "loading") { CircularProgressIndicator(Modifier.padding(16.dp).size(24.dp)) }
            if (!loading && listing?.entries.isNullOrEmpty()) item(key = "empty") {
                Text("Подпапок нет", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
            }
            items(listing?.entries.orEmpty(), key = { it.path }) { folder ->
                Row(Modifier.fillMaxWidth().clickable(enabled = !saving) { open(folder.path) }.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(AppIcons.Folder, null, Modifier.size(20.dp))
                    Spacer(Modifier.width(12.dp))
                    Text(folder.name, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Icon(AppIcons.ChevronRight, null, Modifier.size(16.dp))
                }
            }
        },
        footer = {
            TextButton(onClick = { open(listing?.parent) }, enabled = !loading && !saving && listing?.path != null) { Text("Вверх") }
            Spacer(Modifier.weight(1f))
            Button(onClick = {
                val path = listing?.path ?: return@Button
                saving = true
                error = null
                scope.launch {
                    sessions.registerProject(path, name.trim())
                        .onSuccess(onRegistered)
                        .onFailure { error = it.message ?: "Не удалось добавить проект" }
                    saving = false
                }
            }, enabled = !loading && !saving && listing?.path != null) {
                if (saving) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                else Text("Добавить проект")
            }
        },
    ) {}
}
