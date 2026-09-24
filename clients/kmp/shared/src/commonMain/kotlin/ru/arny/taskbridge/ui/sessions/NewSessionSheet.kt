package ru.arny.taskbridge.ui.sessions

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.api.ModelCatalog
import ru.arny.taskbridge.core.api.ModelRef
import ru.arny.taskbridge.core.api.Project
import ru.arny.taskbridge.core.api.SCRATCH_PROJECT_ID
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.UploadFile
import ru.arny.taskbridge.platform.rememberFilePicker
import ru.arny.taskbridge.ui.common.SectionTitle
import ru.arny.taskbridge.ui.common.formatBytes
import ru.arny.taskbridge.ui.theme.AppIcons

@Composable
fun NewSessionSheet(
    graph: AppGraph,
    connection: AppGraph.Connected,
    projects: List<Project>,
    onDismiss: () -> Unit,
    onCreated: (Task) -> Unit,
) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var projectId by remember { mutableStateOf(projects.firstOrNull()?.id ?: SCRATCH_PROJECT_ID) }
    var prompt by remember { mutableStateOf("") }
    var title by remember { mutableStateOf("") }
    var catalog by remember { mutableStateOf<ModelCatalog?>(null) }
    var model by remember { mutableStateOf<ModelRef?>(null) }
    var thinking by remember { mutableStateOf<String?>(null) }
    var files by remember { mutableStateOf<List<UploadFile>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val commandId = remember { graph.newId() }
    val pick = rememberFilePicker { picked -> files = files + picked }

    LaunchedEffect(Unit) {
        connection.sessions.models().onSuccess { loaded ->
            catalog = loaded
            model = loaded.defaultModel?.let { default -> loaded.models.firstOrNull { it.id == default.id && (default.provider == null || it.provider == default.provider) } ?: default }
            thinking = loaded.defaultThinkingLevel
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 16.dp).navigationBarsPadding().imePadding(),
        ) {
            Text("Новая сессия", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.height(12.dp))

            SectionTitle("Проект", Modifier.padding(start = 0.dp))
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (project in projects) {
                    FilterChip(
                        selected = projectId == project.id,
                        onClick = { projectId = project.id },
                        label = { Text(project.displayName) },
                        leadingIcon = { Icon(AppIcons.Folder, null, Modifier.size(16.dp)) },
                    )
                }
                FilterChip(
                    selected = projectId == SCRATCH_PROJECT_ID,
                    onClick = { projectId = SCRATCH_PROJECT_ID },
                    label = { Text("Без проекта") },
                )
            }

            SectionTitle("Модель", Modifier.padding(start = 0.dp, top = 8.dp))
            ModelPicker(catalog, model, onPick = { model = it })
            val levels = catalog?.thinkingLevels.orEmpty()
            if (levels.isNotEmpty() && model?.reasoning != false) {
                Spacer(Modifier.height(8.dp))
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (level in levels) {
                        FilterChip(selected = thinking == level, onClick = { thinking = level }, label = { Text(thinkingLabel(level)) })
                    }
                }
            }

            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = prompt,
                onValueChange = { prompt = it; error = null },
                label = { Text("Задача для агента") },
                placeholder = { Text("Например: найди, почему падает тест X, и исправь") },
                minLines = 4,
                modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp),
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                label = { Text("Название (необязательно)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            if (files.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (file in files) {
                        InputChip(
                            selected = false,
                            onClick = { files = files - file },
                            label = { Text("${file.name} · ${formatBytes(file.bytes.size.toLong())}") },
                            trailingIcon = { Icon(AppIcons.Close, "Убрать", Modifier.size(16.dp)) },
                        )
                    }
                }
            }
            if (error != null) {
                Spacer(Modifier.height(8.dp))
                Text(error.orEmpty(), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(16.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(onClick = pick) {
                    Icon(AppIcons.Attach, null, Modifier.size(18.dp))
                    Spacer(Modifier.size(6.dp))
                    Text("Файлы")
                }
                Spacer(Modifier.weight(1f))
                Button(
                    enabled = !busy && (prompt.isNotBlank() || files.isNotEmpty()),
                    onClick = {
                        busy = true
                        error = null
                        scope.launch {
                            connection.sessions.create(projectId, prompt.ifBlank { "Посмотри приложенные файлы" }, model, thinking, title, files, commandId)
                                .onSuccess { task ->
                                    sheet.hide()
                                    onCreated(task)
                                }
                                .onFailure { error = messageOf(it) }
                            busy = false
                        }
                    },
                ) {
                    if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                    else {
                        Icon(AppIcons.Send, null, Modifier.size(18.dp))
                        Spacer(Modifier.size(8.dp))
                        Text("Начать")
                    }
                }
            }
        }
    }
}

/** A dropdown of Pi's models, grouped by provider in the label. */
@Composable
fun ModelPicker(catalog: ModelCatalog?, selected: ModelRef?, onPick: (ModelRef) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Column {
        AssistChip(
            onClick = { open = true },
            label = { Text(selected?.let { "${it.label}${it.provider?.let { p -> " · $p" }.orEmpty()}" } ?: if (catalog == null) "Загружаю модели…" else "По умолчанию") },
            leadingIcon = { Icon(AppIcons.Spark, null, Modifier.size(16.dp)) },
            trailingIcon = { Icon(AppIcons.ChevronDown, null, Modifier.size(16.dp)) },
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            val models = catalog?.models.orEmpty()
            if (models.isEmpty()) DropdownMenuItem(text = { Text("Pi не отдал список моделей") }, onClick = { open = false }, enabled = false)
            for ((provider, group) in models.groupBy { it.provider ?: "—" }) {
                DropdownMenuItem(text = { Text(provider, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary) }, onClick = {}, enabled = false)
                for (item in group) {
                    DropdownMenuItem(
                        text = {
                            Column {
                                Text(item.label)
                                val details = listOfNotNull(
                                    item.contextWindow?.let { "контекст ${it / 1000}K" },
                                    "думает".takeIf { item.reasoning == true },
                                    "картинки".takeIf { item.images == true },
                                ).joinToString(" · ")
                                if (details.isNotEmpty()) Text(details, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        },
                        leadingIcon = { if (item.key == selected?.key) Icon(AppIcons.Check, null) else Spacer(Modifier.size(24.dp)) },
                        onClick = { open = false; onPick(item) },
                    )
                }
            }
        }
    }
}

fun thinkingLabel(level: String): String = when (level) {
    "off" -> "Без размышлений"
    "minimal" -> "Минимум"
    "low" -> "Коротко"
    "medium" -> "Средне"
    "high" -> "Глубоко"
    "xhigh" -> "Максимум"
    else -> level
}
