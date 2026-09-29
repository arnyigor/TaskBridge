package ru.arny.taskbridge.ui.sessions

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import kotlin.math.roundToInt
import io.ktor.http.Url
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.api.ModelCatalog
import ru.arny.taskbridge.core.api.ModelLatency
import ru.arny.taskbridge.core.api.ModelRef
import ru.arny.taskbridge.core.client.settings.AppSettings
import ru.arny.taskbridge.ui.theme.LocalStatusColors
import androidx.compose.material3.IconButton
import ru.arny.taskbridge.core.api.Project
import ru.arny.taskbridge.core.api.SCRATCH_PROJECT_ID
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.UploadFile
import ru.arny.taskbridge.platform.rememberFilePicker
import ru.arny.taskbridge.ui.SessionDraft
import ru.arny.taskbridge.ui.common.AdaptiveSheet
import ru.arny.taskbridge.ui.common.formatBytes
import ru.arny.taskbridge.ui.theme.AppIcons

@Composable
fun NewSessionSheet(
    graph: AppGraph,
    connection: AppGraph.Connected,
    projects: List<Project>,
    /** The folder to start in (the folder menu's "new session here"); the first project otherwise. */
    initialProjectId: String? = null,
    onDismiss: () -> Unit,
    onCreated: (Task) -> Unit,
    /** No task typed: open the chat now, the session is created by its first message. */
    onDraft: (SessionDraft) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var projectId by remember { mutableStateOf(initialProjectId ?: projects.firstOrNull()?.id ?: SCRATCH_PROJECT_ID) }
    var prompt by remember { mutableStateOf("") }
    var title by remember { mutableStateOf("") }
    var catalog by remember { mutableStateOf<ModelCatalog?>(null) }
    var model by remember { mutableStateOf<ModelRef?>(null) }
    var thinking by remember { mutableStateOf<String?>(null) }
    var files by remember { mutableStateOf<List<UploadFile>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var browsingProjects by remember { mutableStateOf(false) }
    var addedProject by remember { mutableStateOf<Project?>(null) }
    var addingFolder by remember { mutableStateOf(false) }
    val commandId = remember { graph.newId() }
    val pick = rememberFilePicker { picked -> files = files + picked }
    val visibleProjects = projects + listOfNotNull(addedProject).filterNot { added -> projects.any { it.id == added.id } }
    val localDesktop = graph.platform.kind == "desktop" && runCatching {
        Url(connection.baseUrl).host.lowercase() in setOf("localhost", "127.0.0.1", "::1", "[::1]")
    }.getOrDefault(false)

    LaunchedEffect(Unit) {
        connection.sessions.models().onSuccess { loaded ->
            catalog = loaded
            val chosen = loaded.defaultModel?.let { default -> loaded.models.firstOrNull { it.id == default.id && (default.provider == null || it.provider == default.provider) } ?: default }
            model = chosen
            // Уровень по умолчанию мог быть сохранён для другой модели, а карта у
            // каждой своя (Strata не принимает «minimal»/«max»).
            thinking = clampThinkingLevel(loaded.defaultThinkingLevel, thinkingChoices(chosen, loaded.thinkingLevels))
        }
    }

    AdaptiveSheet(
        title = "Новая сессия",
        onDismiss = onDismiss,
        maxWidth = 640,
        footer = {
            OutlinedButton(onClick = pick) {
                Icon(AppIcons.Attach, null, Modifier.size(18.dp))
                Spacer(Modifier.size(6.dp))
                Text("Файлы")
            }
            Spacer(Modifier.weight(1f))
            Button(
                enabled = !busy,
                onClick = {
                    if (prompt.isBlank() && files.isEmpty()) {
                        val name = visibleProjects.firstOrNull { it.id == projectId }?.displayName ?: "Без проекта"
                        onDraft(SessionDraft(projectId, name, model, thinking, title.trim().ifEmpty { null }, commandId))
                    } else {
                        busy = true
                        error = null
                        scope.launch {
                            connection.sessions.create(projectId, prompt.ifBlank { "Посмотри приложенные файлы" }, model, thinking, title, files, commandId)
                                .onSuccess { onCreated(it) }
                                .onFailure { error = messageOf(it) }
                            busy = false
                        }
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
        },
    ) {
        FieldLabel("Проект")
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (project in visibleProjects) {
                FilterChip(
                    selected = projectId == project.id,
                    onClick = { projectId = project.id },
                    label = { Text(project.displayName) },
                    leadingIcon = { Icon(AppIcons.Folder, null, Modifier.size(16.dp)) },
                )
            }
            FilterChip(selected = projectId == SCRATCH_PROJECT_ID, onClick = { projectId = SCRATCH_PROJECT_ID }, label = { Text("Без проекта") })
            OutlinedButton(onClick = {
                if (localDesktop) {
                    val selected = runCatching { graph.platform.chooseProjectFolder() }
                        .onFailure { error = it.message ?: "Не удалось открыть выбор папки" }.getOrNull()
                    if (selected != null) {
                        addingFolder = true
                        error = null
                        scope.launch {
                            connection.sessions.registerLocalProject(selected)
                                .onSuccess { project -> addedProject = project; projectId = project.id }
                                .onFailure { error = messageOf(it) }
                            addingFolder = false
                        }
                    }
                } else browsingProjects = true
            }, enabled = !addingFolder) {
                Icon(AppIcons.Add, null, Modifier.size(16.dp))
                Spacer(Modifier.size(4.dp))
                Text(if (addingFolder) "Добавляю…" else if (localDesktop) "Выбрать любую папку…" else "Добавить папку")
            }
        }

        FieldLabel("Модель", top = 16)
        ModelPicker(catalog, model, graph.settings, onPick = { model = it; thinking = clampThinkingLevel(thinking, thinkingChoices(it, catalog?.thinkingLevels.orEmpty())) })
        // Уровни — из карты выбранной модели: у локальных (Strata) набор другой,
        // чем у модели Pi по умолчанию, и «Глубоко» там означает xhigh.
        val levels = thinkingChoices(model, catalog?.thinkingLevels.orEmpty())
        if (levels.isNotEmpty() && model?.reasoning != false) {
            FieldLabel("Размышления", top = 16)
            ThinkingPicker(levels, thinking, model = model, onPick = { thinking = it })
        }

        Spacer(Modifier.height(16.dp))
        OutlinedTextField(
            value = prompt,
            onValueChange = { prompt = it; error = null },
            label = { Text("Задача для агента") },
            placeholder = { Text("Можно не заполнять — напишете в чате") },
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
    }
    if (browsingProjects) ProjectBrowserSheet(connection.sessions, onDismiss = { browsingProjects = false }) { project ->
        addedProject = project
        projectId = project.id
        browsingProjects = false
    }
}

@Composable
fun FieldLabel(text: String, top: Int = 0) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = top.dp, bottom = 8.dp),
    )
}

private fun ModelRef.details(latency: ModelLatency? = null): String = listOfNotNull(
    provider,
    contextWindow?.let { "контекст ${it / 1000}K" },
    maxTokens?.let { "ответ до ${it / 1000}K" },
    "думает".takeIf { reasoning == true },
    "картинки".takeIf { images == true },
    "tools".takeIf { tools == true },
    cost?.let { price ->
        listOfNotNull(price.input?.let { "in \$$it" }, price.output?.let { "out \$$it" }).takeIf { it.isNotEmpty() }?.joinToString("/")
    },
    modelLatencyLabel(latency),
).joinToString(" · ")

// «первый токен ≈ 2.1 с · 5 зап.» — measured TTFT for the model (catalog.latency,
// keyed by ModelRef.key). Cloud models are the main reason to look at it: they
// can stay silent long after the prompt is sent, and this number says how long
// is normal for them.
fun modelLatencyLabel(latency: ModelLatency?): String? {
    val ms = latency?.let { it.p50Ms ?: it.avgMs } ?: return null
    val count = latency?.count ?: 0
    return "первый токен ≈ ${formatLatencyMs(ms)}${if (count > 0) " · $count зап." else ""}"
}

// The session's model as Pi reported it does not always carry a provider, and for
// the local router Pi's provider id can differ from the one in models.json (see
// resolveLocalProviderId), so the recorded key can be `provider/id`, `/id` or an
// id under another provider. An exact key wins; otherwise any key with the same
// model id is taken (with several providers offering one id, the first wins).
fun ModelCatalog.latencyFor(model: ModelRef?): ModelLatency? {
    val id = model?.id ?: return null
    return latency["${model.provider.orEmpty()}/$id"]
        ?: latency.filterKeys { it.substringAfterLast('/') == id }.values.firstOrNull()
}

fun formatLatencyMs(ms: Long): String =
    if (ms < 1000) "$ms мс"
    else {
        val s = ms / 1000.0
        if (s < 10) "${(s * 10).roundToInt() / 10.0} с" else "${s.roundToInt()} с"
    }

/** The chosen model as a row; tapping it opens the searchable list of Pi's models. */
@Composable
fun ModelPicker(catalog: ModelCatalog?, selected: ModelRef?, settings: AppSettings, onPick: (ModelRef) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Surface(
        onClick = { open = true },
        enabled = catalog != null,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(AppIcons.Spark, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(selected?.label ?: if (catalog == null) "Загружаю модели…" else "По умолчанию", style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                selected?.details(catalog?.latencyFor(selected))?.takeIf { it.isNotEmpty() }?.let {
                    Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (catalog == null) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            else Text("Сменить", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
        }
    }
    if (open && catalog != null) ModelChooser(catalog, selected, settings, onPick = { open = false; onPick(it) }, onDismiss = { open = false })
}

/** Заголовок общей группы локальных моделей в пикере: пресеты llama.cpp-роутера и
 * настроенные внешние серверы (Strata) — одна машина, хотя Pi-провайдеры у них разные. */
private const val LOCAL_MODELS_GROUP = "Локальные модели"
private const val FAVORITES_GROUP = "★ Избранное"

/**
 * Группы пикера моделей: избранное → локальные модели одной группой (по флагу
 * `local`, а не по имени провайдера: llama.cpp-роутер и внешние серверы вроде
 * Strata имеют разные Pi-провайдеры) → остальные провайдеры по алфавиту.
 * Избранное фиксируется на момент открытия списка ([pinnedFirst]), чтобы новая
 * звезда не вставляла строки под пальцем.
 */
internal fun modelGroups(models: List<ModelRef>, pinnedFirst: Set<String>): List<Pair<String, List<ModelRef>>> {
    val starred = models.filter { it.key in pinnedFirst }
    val rest = models.filterNot { it.key in pinnedFirst }
        .groupBy { if (it.local) LOCAL_MODELS_GROUP else it.provider ?: "—" }
        .toList()
        .sortedWith(compareBy({ it.first != LOCAL_MODELS_GROUP }, { it.first.lowercase() }))
    return (if (starred.isNotEmpty()) listOf(FAVORITES_GROUP to starred) else emptyList()) + rest
}

@Composable
fun ModelChooser(catalog: ModelCatalog, selected: ModelRef?, settings: AppSettings, onPick: (ModelRef) -> Unit, onDismiss: () -> Unit, pendingKey: String? = null) {
    var query by remember { mutableStateOf("") }
    var favorites by remember { mutableStateOf(settings.favoriteModels) }
    var expanded by remember { mutableStateOf<Set<String>>(emptySet()) }
    // The «Избранное» group is fixed when the chooser opens: a star tapped now must
    // not insert rows above the finger and turn the next tap into a model pick.
    val pinnedFirst = remember { settings.favoriteModels }
    val searchIndex = remember(catalog.models) {
        catalog.models.map { model -> model to "${model.label} ${model.id.orEmpty()} ${model.provider.orEmpty()}".lowercase() }
    }
    val words = remember(query) { query.trim().lowercase().split(' ').filter(String::isNotEmpty) }
    val filteredModels = remember(searchIndex, words) {
        if (words.isEmpty()) catalog.models else searchIndex.filter { (_, text) -> words.all(text::contains) }.map { it.first }
    }
    val groups = remember(filteredModels, pinnedFirst) { modelGroups(filteredModels, pinnedFirst) }
    fun toggle(key: String) {
        favorites = if (key in favorites) favorites - key else favorites + key
        settings.favoriteModels = favorites
    }
    AdaptiveSheet(
        title = "Выбор модели",
        onDismiss = onDismiss,
        subtitle = "Текущая: ${selected?.let { "${it.provider}/${it.id}" } ?: "не выбрана"}",
        maxWidth = 520,
        pinned = {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text("Поиск: провайдер, ID или название") },
                leadingIcon = { Icon(AppIcons.Search, null, Modifier.size(18.dp)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        },
        footer = {
            Text("Всего ${catalog.models.size} · показано ${filteredModels.size}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        },
        // Pi's catalogue easily reaches ~1000 models: a plain Column composes them
        // all eagerly, which freezes the sheet at open and recomposes every row on
        // each star tap and search keystroke. The lazyContent slot gives the list
        // the remaining sheet height and only the visible rows compose.
        lazyContent = {
            if (filteredModels.isEmpty()) {
                item(key = "empty") {
                    Text(
                        if (catalog.models.isEmpty()) "Pi не отдал список моделей" else "Ничего не найдено",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 24.dp),
                    )
                }
            }
            // Starred models first, so the usual ones are one tap away. A starred
            // model stays in its provider group in the data, but visually it is
            // shown only once — its provider-group row is hidden here.
            for ((provider, group) in groups) {
                val openGroup = words.isNotEmpty() || provider in expanded
                item(key = "provider:$provider", contentType = "provider") {
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).clickable {
                            expanded = if (provider in expanded) expanded - provider else expanded + provider
                        }.padding(horizontal = 8.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(if (openGroup) AppIcons.ChevronDown else AppIcons.ChevronRight, null, Modifier.size(16.dp))
                        Spacer(Modifier.width(12.dp))
                        Text(provider, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                        Text("${group.size} моделей", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (!openGroup) continue
                // A starred model also appears in its provider group, so the row
                // keys must include the group or LazyColumn rejects the duplicate.
                items(group, key = { "model:$provider:${it.key}" }, contentType = { "model" }) { model ->
                    val current = model.key == selected?.key
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .clickable(enabled = pendingKey == null) { onPick(model) }
                            .padding(start = 36.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(model.id ?: model.label, style = MaterialTheme.typography.bodyLarge, color = if (current) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                            val details = listOfNotNull(
                                // В общей локальной группе заголовок больше не называет
                                // движок, поэтому провайдер виден в самой строке.
                                model.provider?.takeIf { model.local && it.isNotBlank() },
                                model.name?.takeIf { it != model.id },
                                model.contextWindow?.let { "контекст ${it / 1000}K" },
                                "думает".takeIf { model.reasoning == true },
                                "картинки".takeIf { model.images == true },
                                modelLatencyLabel(catalog.latencyFor(model)),
                            ).joinToString(" · ")
                            if (details.isNotEmpty()) Text(details, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (pendingKey == model.key) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        else if (current) Icon(AppIcons.Check, "Выбрана", Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
                        val favorite = model.key in favorites
                        IconButton(onClick = { toggle(model.key) }) {
                            Icon(
                                if (favorite) AppIcons.StarFilled else AppIcons.Star,
                                if (favorite) "Убрать из избранного" else "В избранное",
                                Modifier.size(20.dp),
                                tint = if (favorite) LocalStatusColors.current.waiting else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        },
    ) {
    }
}

/** Pi's thinking levels as chips that wrap, so none hides behind a scroll on a wide window. */
@Composable
fun ThinkingPicker(levels: List<String>, current: String?, model: ModelRef? = null, onPick: (String) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for (level in levels) {
            FilterChip(selected = current == level, onClick = { onPick(level) }, label = { Text(thinkingOptionLabel(model, level)) })
        }
    }
}

/**
 * Уровни для пикера: карта выбранной модели, а не общий список каталога (тот
 * относится к текущей модели Pi по умолчанию и для локальных моделей неверен).
 * Пустая карта (модель ещё не выбрана, или её нет в каталоге) — откат на общий
 * список, чтобы пикер не остался пустым.
 */
internal fun thinkingChoices(model: ModelRef?, catalogLevels: List<String>): List<String> {
    val own = model?.thinkingLevels.orEmpty()
    return if (own.isNotEmpty()) own else catalogLevels
}

/**
 * Подпись уровня вместе с его значением у провайдера: «Глубоко → xhigh». Значение
 * показывается только там, где оно отличается от самого уровня и не является его
 * отсутствием (off → none читалось бы как лишний шум).
 */
internal fun thinkingOptionLabel(model: ModelRef?, level: String): String {
    val label = thinkingLabel(level)
    val mapped = model?.thinkingMap?.get(level)
    if (mapped.isNullOrBlank() || mapped == level || level == "off") return label
    return "$label → $mapped"
}

/**
 * Ближайший уровень, который примет модель, — по правилу самого Pi
 * (clampThinkingLevel): вверх от запрошенного, потом вниз. Нужен при смене
 * модели в форме новой сессии: выбранный ранее «Минимум» у Strata невалиден.
 */
internal fun clampThinkingLevel(level: String?, levels: List<String>): String? {
    if (level == null || levels.isEmpty() || level in levels) return level
    val order = listOf("off", "minimal", "low", "medium", "high", "xhigh", "max")
    val requested = order.indexOf(level)
    if (requested < 0) return levels.first()
    for (index in requested until order.size) if (order[index] in levels) return order[index]
    for (index in requested - 1 downTo 0) if (order[index] in levels) return order[index]
    return levels.first()
}

fun thinkingLabel(level: String): String = when (level) {
    "off" -> "Без размышлений"
    "minimal" -> "Минимум"
    "low" -> "Коротко"
    "medium" -> "Средне"
    "high" -> "Глубоко"
    "xhigh" -> "Максимум"
    "max" -> "Предел"
    else -> level
}
