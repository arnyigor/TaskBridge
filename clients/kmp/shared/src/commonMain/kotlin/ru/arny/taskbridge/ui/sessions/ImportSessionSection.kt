package ru.arny.taskbridge.ui.sessions

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.api.NativeImportMode
import ru.arny.taskbridge.core.api.NativeSession
import ru.arny.taskbridge.core.api.NativeSessionPreview
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.ui.common.relativeTime
import ru.arny.taskbridge.ui.theme.AppIcons

/**
 * У папки бывает сотня сессий, а столбец диалога не ленивый: без поиска
 * показываем только свежие — остальное сужается запросом.
 */
private const val MAX_ROWS = 40

/**
 * Импорт сессии Pi внутри диалога «Новая сессия»: папка выбрана выше, поэтому
 * ищем сессии только в ней (GET /api/projects/{id}/pi-sessions). Сервер сам
 * проверяет, что файл сессии принадлежит этому каталогу, и отдаёт клиенту
 * непрозрачный ключ — путь в запрос не уходит.
 *
 * Два шага, как в вебе: список (с поиском) → предпросмотр с выбором режима.
 * «Копия» безопасна и по умолчанию; «Забрать оригинал» забирает файл сессии у
 * терминала, поэтому требует отдельного подтверждения — сервер без него откажет.
 *
 * [projectId] == null (сессия «без проекта») — папки нет, искать негде.
 */
@Composable
fun ImportSessionSection(
    graph: AppGraph,
    connection: AppGraph.Connected,
    projectId: String?,
    onImported: (Task) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var loading by remember { mutableStateOf(projectId != null) }
    var sessions by remember { mutableStateOf<List<NativeSession>>(emptyList()) }
    var query by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf<NativeSession?>(null) }
    var preview by remember { mutableStateOf<NativeSessionPreview?>(null) }
    var previewLoading by remember { mutableStateOf(false) }
    var mode by remember { mutableStateOf(NativeImportMode.Clone) }
    var confirmedClosed by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // Другая папка — другой список: выбор и предпросмотр прежней сессии к нему
    // не относятся, поэтому сбрасываются вместе с ним.
    LaunchedEffect(projectId) {
        selected = null
        preview = null
        mode = NativeImportMode.Clone
        confirmedClosed = false
        error = null
        sessions = emptyList()
        if (projectId == null) {
            loading = false
            return@LaunchedEffect
        }
        loading = true
        runCatching { connection.api.nativeSessions(projectId) }
            .onSuccess { sessions = it }
            .onFailure { error = messageOf(it) }
        loading = false
    }

    // Предпросмотр — отдельный запрос: он читает сам JSONL сессии.
    LaunchedEffect(selected, projectId) {
        val session = selected ?: return@LaunchedEffect
        val project = projectId ?: return@LaunchedEffect
        previewLoading = true
        preview = null
        error = null
        runCatching { connection.api.nativeSessionPreview(project, session.key) }
            .onSuccess { preview = it }
            .onFailure { error = messageOf(it) }
        previewLoading = false
    }

    if (projectId == null) {
        Text(
            "Импорт ищет сессии в папке, а у сессии «без проекта» её нет — выберите папку выше.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        return
    }

    val session = selected
    if (session == null) {
        // Уже импортированные сессии не показываем: импорт такой вернул бы ту же
        // задачу, а не новую (сервер помечает их existingTaskId).
        val importable = importableNativeSessions(sessions)
        val alreadyImported = sessions.size - importable.size
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            label = { Text("Поиск по имени и последним репликам") },
            leadingIcon = { Icon(AppIcons.Search, null, Modifier.size(18.dp)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        if (!loading && alreadyImported > 0) {
            Spacer(Modifier.height(6.dp))
            Text(
                "Уже открыты в TaskBridge и не показываются: $alreadyImported.",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.height(8.dp))
        val visible = filterNativeSessions(importable, query)
        when {
            loading -> Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(10.dp))
                Text("Опрашиваю папку", style = MaterialTheme.typography.bodyMedium)
            }
            visible.isEmpty() -> Text(
                when {
                    sessions.isEmpty() -> "В этой папке сессий Pi не найдено."
                    importable.isEmpty() -> "Все найденные сессии уже открыты в TaskBridge."
                    else -> "Под запрос ничего не подходит."
                },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(vertical = 12.dp),
            )
            else -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (item in visible.take(MAX_ROWS)) {
                    SessionRow(graph, item) { selected = item }
                }
                if (visible.size > MAX_ROWS) {
                    Text(
                        "Показаны первые $MAX_ROWS из ${visible.size} — уточните поиск.",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    } else {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(session.displayName, style = MaterialTheme.typography.titleSmall)
            if (previewLoading) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Text("Читаю сессию", style = MaterialTheme.typography.bodySmall)
                }
            }
            preview?.let { p ->
                val model = listOfNotNull(p.model?.provider, p.model?.id).joinToString("/")
                InfoLine("Сообщений", "${p.messageCount} (записей: ${p.entryCount})")
                if (model.isNotBlank()) InfoLine("Модель", model)
                p.thinkingLevel?.let { InfoLine("Thinking", it) }
                p.tokens?.let { InfoLine("Токенов", it.toString()) }
                p.lastUser?.takeIf { it.isNotBlank() }?.let { InfoLine("Последний вопрос", it) }
                p.lastAssistant?.takeIf { it.isNotBlank() }?.let { InfoLine("Последний ответ", it) }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                for (option in NativeImportMode.entries) {
                    FilterChip(
                        selected = mode == option,
                        onClick = { mode = option; if (option == NativeImportMode.Clone) confirmedClosed = false },
                        label = { Text(option.label) },
                    )
                    Spacer(Modifier.width(6.dp))
                }
            }
            Text(
                if (mode == NativeImportMode.Clone) {
                    "История копируется в папку задачи: сессия в терминале остаётся рабочей."
                } else {
                    "Оригинальный файл сессии переходит приложению — в терминале её нужно закрыть."
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (mode == NativeImportMode.TakeOver) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(confirmedClosed, { confirmedClosed = it })
                    Text("Сессия Pi в терминале закрыта", style = MaterialTheme.typography.bodySmall)
                }
            }
            if (preview?.existingTaskId != null || session.existingTaskId != null) {
                Text(
                    "Эта сессия уже импортирована: импорт вернёт существующую задачу.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Button(
                enabled = !busy && !previewLoading && (mode != NativeImportMode.TakeOver || confirmedClosed),
                onClick = {
                    busy = true
                    scope.launch {
                        runCatching { connection.api.importNativeSession(projectId, session.key, mode, confirmedClosed) }
                            .onSuccess { task -> busy = false; onImported(task) }
                            .onFailure { busy = false; error = messageOf(it) }
                    }
                },
            ) { Text(if (busy) "Импортирую…" else "Импортировать") }
            TextButton(onClick = { selected = null; preview = null; mode = NativeImportMode.Clone; confirmedClosed = false }) {
                Text("Назад к списку")
            }
        }
    }
    error?.let {
        Spacer(Modifier.height(8.dp))
        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
    }
}

/**
 * Сессии, которые ещё не открыты в TaskBridge. Уже импортированные не
 * предлагаются: импорт такой сессии вернул бы существующую задачу, то есть
 * выбора «что открыть» для неё уже нет (флаг ставит сервер по своим задачам).
 */
internal fun importableNativeSessions(sessions: List<NativeSession>): List<NativeSession> =
    sessions.filter { it.existingTaskId == null }

/**
 * Поиск по списку сессий папки: имя, id и последние реплики; слова ищутся
 * независимо («импорт тест» находит сессию, где они в разных местах) — так же,
 * как поиск по моделям.
 */
internal fun filterNativeSessions(sessions: List<NativeSession>, query: String): List<NativeSession> {
    val words = query.trim().lowercase().split(' ').filter(String::isNotEmpty)
    if (words.isEmpty()) return sessions
    return sessions.filter { session ->
        val text = listOfNotNull(session.name, session.id, session.preview).joinToString(" ").lowercase()
        words.all(text::contains)
    }
}

@Composable
private fun SessionRow(graph: AppGraph, session: NativeSession, onClick: () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable(onClick = onClick),
    ) {
        Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(AppIcons.Terminal, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.width(6.dp))
                    Text(
                        session.displayName,
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                }
                session.preview?.takeIf { it.isNotBlank() }?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            val stamp = relativeTime(graph.platform, session.mtime, graph.nowMillis())
            if (stamp.isNotEmpty()) {
                Text(
                    stamp,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
        }
    }
}

@Composable
private fun InfoLine(label: String, value: String) {
    Column(Modifier.fillMaxWidth().heightIn(min = 18.dp)) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis)
    }
}
