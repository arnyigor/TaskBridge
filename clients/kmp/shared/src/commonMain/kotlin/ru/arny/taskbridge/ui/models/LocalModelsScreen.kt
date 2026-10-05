package ru.arny.taskbridge.ui.models

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.FlowRowScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.api.HfDownloadJob
import ru.arny.taskbridge.core.api.HfRepoInfo
import ru.arny.taskbridge.core.api.HfSearchResult
import ru.arny.taskbridge.core.api.HfVariant
import ru.arny.taskbridge.core.api.LibraryEntry
import ru.arny.taskbridge.core.api.LocalModelEntry
import ru.arny.taskbridge.core.api.LocalRuntimeInfo
import ru.arny.taskbridge.core.api.LocalVisionChange
import ru.arny.taskbridge.ui.common.Banner
import ru.arny.taskbridge.ui.common.SectionTitle
import ru.arny.taskbridge.ui.theme.AppIcons
import ru.arny.taskbridge.ui.theme.LocalStatusColors
import kotlin.math.roundToInt

/**
 * Отдельный экран «Локальные модели»: управление — это действие (найти →
 * скачать → запустить → остановить), а не настройка, поэтому из «Настроек»
 * здесь остаётся только кнопка. Три вкладки: установленные модели, поиск на
 * Hugging Face и очередь загрузок (задания живут на сервере и переживают
 * перезапуск; при входе на экран их список читается сразу).
 *
 * Терминология разведена намеренно: «Скачать» — привезти файлы с Hugging Face,
 * «Запустить»/«Остановить» — загрузить/выгрузить модель в runtime. Слово
 * «Загрузить» значило и то и другое и читалось неоднозначно.
 *
 * Раскладка рассчитана на телефон: имя модели занимает всю ширину строки и не
 * делит её с кнопками (на узком экране «Контекст» + «Запустить» выдавливали
 * имя в «qwen3.8-flash-next-…»), состояние видно точкой и подписью под именем,
 * а действия стоят отдельной строкой ниже.
 */
@Composable
fun LocalModelsScreen(graph: AppGraph, connection: AppGraph.Connected, onBack: () -> Unit) {
    val state by connection.sessions.state.collectAsState()
    val info = state.info
    val scope = rememberCoroutineScope()

    // --- установленная модель: загрузка/выгрузка через /api/local/* ---
    var busyId by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf<String?>(null) }
    // Свежий /api/local. В покое /api/info обновляет локальные модели раз в
    // 50 с (каждый 5-й тик по 10 с), поэтому «запускается» висело на экране до
    // ручного «Обновить список», хотя модель уже была загружена.
    var local by remember { mutableStateOf<LocalRuntimeInfo?>(null) }

    // --- Hugging Face ---
    var tab by rememberSaveable { mutableStateOf(0) }
    var query by rememberSaveable { mutableStateOf("") }
    var searching by remember { mutableStateOf(false) }
    var results by remember { mutableStateOf<List<HfSearchResult>?>(null) }
    var repo by remember { mutableStateOf<HfRepoInfo?>(null) }
    var repoLoading by remember { mutableStateOf(false) }

    // --- загрузки ---
    var downloads by remember { mutableStateOf<List<HfDownloadJob>>(emptyList()) }
    var busyJobId by remember { mutableStateOf<String?>(null) }
    // Библиотека установленных с HF моделей: в списке роутера они появляются
    // только после «В Pi» и перезапуска роутера, поэтому показываем их сами.
    var library by remember { mutableStateOf<List<LibraryEntry>>(emptyList()) }

    fun readLocal() {
        scope.launch { runCatching { connection.api.local(fresh = true) }.onSuccess { local = it } }
    }

    fun refreshLibrary() {
        scope.launch { runCatching { connection.api.library(fresh = true) }.onSuccess { library = it.models } }
    }

    fun refreshDownloads() {
        scope.launch { runCatching { connection.api.hfDownloads() }.onSuccess { downloads = it.jobs } }
    }

    fun refreshAll() {
        refreshing = true
        scope.launch {
            runCatching { connection.api.local(fresh = true) }
                .onSuccess { local = it }
                .onFailure { error = it.message ?: "Не удалось обновить список локальных моделей" }
            runCatching { connection.api.library(fresh = true) }.onSuccess { library = it.models }
            runCatching { connection.api.hfDownloads() }.onSuccess { downloads = it.jobs }
            refreshing = false
            connection.sessions.refresh()
        }
    }

    // Задания и библиотека живут на сервере: при входе на экран забираем их текущее состояние.
    LaunchedEffect(Unit) { readLocal(); refreshDownloads(); refreshLibrary() }

    val localInfo = local ?: info?.local
    val models = localInfo?.models.orEmpty()
    val starting = models.any { modelStateOf(it) == ModelState.STARTING }

    // Пока модель грузится — спрашиваем статус сами: и полосу прогресса, и
    // переход «запускается → запущена» иначе показал бы только ручной refresh.
    LaunchedEffect(starting) {
        while (starting) {
            delay(1_500)
            runCatching { connection.api.local(fresh = true) }.onSuccess { local = it }
        }
    }

    // Пока есть активные задания — опрашиваем прогресс раз в 2 с.
    LaunchedEffect(downloads.count { it.active }) {
        while (downloads.any { it.active }) {
            delay(2_000)
            runCatching { connection.api.hfDownloads() }.onSuccess { downloads = it.jobs }
        }
    }

    val activeDownloads = downloads.count { it.active }
    val tabs = listOf("Установленные", "Hugging Face", "Загрузки" + if (activeDownloads > 0) " · $activeDownloads" else "")

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { androidx.compose.material3.IconButton(onClick = onBack) { Icon(AppIcons.Back, "Назад") } },
                title = { Text("Локальные модели") },
                actions = {
                    IconButton(onClick = { refreshAll() }, enabled = !refreshing) {
                        if (refreshing) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        else Icon(AppIcons.Refresh, "Обновить список")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp),
        ) {
            Column(Modifier.widthIn(max = 720.dp)) {
                // Вкладки — отдельным composable: их строка прокручивается, см. LocalModelsTabs.
                LocalModelsTabs(tabs, tab) { tab = it; error = null; note = null }
                // Сообщение о результате действия — сразу под вкладками: раньше
                // оно стояло в самом низу («Контекст модели»), куда после нажатия
                // «Сохранить» никто не смотрит.
                error?.let { Banner(it, AppIcons.Alert, MaterialTheme.colorScheme.error) }
                note?.let { Banner(it, AppIcons.Check, LocalStatusColors.current.done) }

                when (tab) {
                    0 -> InstalledTab(
                        models = models,
                        routerProvider = localInfo?.provider ?: info?.local?.provider,
                        library = library,
                        hidden = localInfo?.hidden.orEmpty(),
                        busyId = busyId,
                        onLoad = { id ->
                            busyId = id
                            scope.launch {
                                runCatching { connection.api.loadLocalModel(id) }
                                    .onFailure { error = it.message ?: "Не удалось загрузить $id" }
                                busyId = null
                                readLocal()
                                connection.sessions.refresh()
                            }
                        },
                        onUnload = { id ->
                            busyId = id
                            scope.launch {
                                runCatching { connection.api.unloadLocalModel(id) }
                                    .onFailure { error = it.message ?: "Не удалось остановить $id" }
                                busyId = null
                                readLocal()
                                connection.sessions.refresh()
                            }
                        },
                        onSetContext = { id, context ->
                            busyId = id
                            note = null
                            scope.launch {
                                runCatching { connection.api.setLocalContext(id, context) }
                                    .onSuccess { change ->
                                        error = null
                                        note = buildString {
                                            append(contextLabel(change.context ?: context))
                                            change.previous?.let { append(" (было ${contextLabel(it)})") }
                                            append(
                                                if (change.restartRequired) " — сервер уже загружен, подхватит следующая загрузка"
                                                else " — подхватится при загрузке модели",
                                            )
                                            change.kvResident?.takeIf { it > (change.context ?: context) }?.let {
                                                append(" · резидентный KV ${contextLabel(it)} больше нового контекста")
                                            }
                                        }
                                    }
                                    .onFailure { error = it.message ?: "Не удалось изменить контекст $id" }
                                busyId = null
                                readLocal()
                                connection.sessions.refresh()
                            }
                        },
                        onSetVision = { id, vision ->
                            busyId = id
                            note = null
                            scope.launch {
                                runCatching { connection.api.setLocalVision(id, vision) }
                                    .onSuccess { error = null; note = visionNote(it) }
                                    .onFailure { error = it.message ?: "Не удалось изменить vision у $id" }
                                busyId = null
                                readLocal()
                                connection.sessions.refresh()
                            }
                        },
                        onForget = { id ->
                            // Найденную строку не удаляют, а скрывают: обещать в заметке
                            // «убран из конфига» было бы неправдой.
                            val hideable = models.firstOrNull { it.id == id }?.hideable == true
                            busyId = id
                            note = null
                            scope.launch {
                                runCatching { connection.api.forgetLocalModel(id) }
                                    .onSuccess {
                                        error = null
                                        note = if (hideable) "$id скрыт из списка — вернуть можно в разделе «Скрытые»"
                                        else "$id убран из конфига — файлы модели не тронуты"
                                    }
                                    .onFailure { error = it.message ?: "Не удалось убрать $id" }
                                busyId = null
                                readLocal()
                                connection.sessions.refresh()
                            }
                        },
                        onUnhide = { id ->
                            busyId = id
                            note = null
                            scope.launch {
                                runCatching { connection.api.unhideLocalModel(id) }
                                    .onSuccess { error = null; note = "$id снова в списке" }
                                    .onFailure { error = it.message ?: "Не удалось вернуть $id" }
                                busyId = null
                                readLocal()
                                connection.sessions.refresh()
                            }
                        },
                        onRegisterLibrary = { id ->
                            busyId = id
                            scope.launch {
                                runCatching { connection.api.registerLibraryModel(id) }
                                    .onSuccess { registered ->
                                        error = null
                                        note = if (registered.restartRequired)
                                            "Пресет «${registered.preset}» добавлен в models.ini — перезапустите роутер, чтобы модель появилась в Pi"
                                        else
                                            "Пресет «${registered.preset}» добавлен в models.ini"
                                    }
                                    .onFailure { error = it.message }
                                busyId = null
                                refreshLibrary()
                                refreshDownloads()
                                readLocal()
                            }
                        },
                        onRunLibrary = { id ->
                            busyId = id
                            scope.launch {
                                runCatching { connection.api.runLibraryModel(id) }
                                    .onSuccess {
                                        error = null
                                        note = "Модель запускается — прогресс видно в карточке выше"
                                        readLocal()
                                        connection.sessions.refresh()
                                    }
                                    .onFailure { error = it.message }
                                busyId = null
                                refreshLibrary()
                            }
                        },
                        onDeleteLibrary = { id ->
                            busyId = id
                            scope.launch {
                                runCatching { connection.api.deleteLibraryModel(id) }
                                    .onSuccess { result ->
                                        error = null
                                        note = buildString {
                                            append("Удалено файлов: ${result.removed.size}")
                                            if (result.freedBytes > 0) append(" · освобождено ${hfSize(result.freedBytes)}")
                                            if (result.presetRemoved) append(" · пресет убран из models.ini")
                                            if (result.kept.isNotEmpty()) append(" · оставлены общие файлы: ${result.kept.size}")
                                        }
                                    }
                                    .onFailure { error = it.message }
                                busyId = null
                                refreshLibrary()
                                refreshDownloads()
                                readLocal()
                                connection.sessions.refresh()
                            }
                        },
                        onOpenHf = { tab = 1; error = null; note = null },
                    )
                    1 -> HuggingFaceTab(
                        query = query,
                        onQuery = { query = it },
                        searching = searching,
                        results = results,
                        repo = repo,
                        repoLoading = repoLoading,
                        onSearch = {
                            searching = true; error = null
                            scope.launch {
                                runCatching { connection.api.hfSearch(query.trim()) }
                                    .onSuccess { results = it; repo = null }
                                    .onFailure { error = it.message ?: "Поиск не удался" }
                                searching = false
                            }
                        },
                        onOpenRepo = { target ->
                            repoLoading = true; error = null
                            scope.launch {
                                runCatching { connection.api.hfRepo(target) }
                                    .onSuccess { repo = it }
                                    .onFailure { error = it.message ?: "Не удалось прочитать репозиторий" }
                                repoLoading = false
                            }
                        },
                        onBackToResults = { repo = null },
                        onDownload = { variant ->
                            val current = repo ?: return@HuggingFaceTab
                            error = null
                            scope.launch {
                                runCatching {
                                    connection.api.hfDownload(current.repo, current.revision, variant.files.map { it.path })
                                }.onSuccess {
                                    refreshDownloads()
                                    tab = 2
                                }.onFailure { error = it.message ?: "Не удалось начать загрузку" }
                            }
                        },
                    )
                    else -> DownloadsTab(
                        downloads = downloads,
                        busyJobId = busyJobId,
                        onCancel = { id ->
                            busyJobId = id
                            scope.launch {
                                runCatching { connection.api.hfCancelDownload(id) }
                                    .onSuccess { downloads = downloads.filter { x -> x.id != it.id } + it }
                                    .onFailure { error = it.message }
                                busyJobId = null
                            }
                        },
                        onRetry = { id ->
                            busyJobId = id
                            scope.launch {
                                runCatching { connection.api.hfRetryDownload(id) }
                                    .onSuccess { downloads = downloads.filter { x -> x.id != it.id } + it }
                                    .onFailure { error = it.message }
                                busyJobId = null
                            }
                        },
                        onRegister = { libraryId ->
                            busyJobId = libraryId
                            scope.launch {
                                runCatching { connection.api.registerLibraryModel(libraryId) }
                                    .onSuccess { registered ->
                                        error = null
                                        note = if (registered.restartRequired)
                                            "Пресет «${registered.preset}» добавлен в models.ini — перезапустите роутер, чтобы модель появилась в Pi"
                                        else
                                            "Пресет «${registered.preset}» добавлен в models.ini"
                                    }
                                    .onFailure { error = it.message }
                                busyJobId = null
                                refreshLibrary()
                                readLocal()
                            }
                        },
                        onClearFinished = {
                            scope.launch {
                                runCatching { connection.api.clearHfDownloads() }
                                    .onSuccess { note = "Очищено завершённых: ${it.removed}"; refreshDownloads() }
                                    .onFailure { error = it.message }
                            }
                        },
                    )
                }
            }
        }
    }
}

/**
 * Вкладки экрана. Строка прокручивается по горизонтали: три подписи на
 * телефоне шире экрана, а в обычной строке последняя («Загрузки») ломалась на
 * «Загрузк/и» — чипы делили ширину, а не просили свою.
 */
@Composable
internal fun LocalModelsTabs(tabs: List<String>, selected: Int, onSelect: (Int) -> Unit) {
    val scroll = rememberScrollState()
    Row(
        Modifier.fillMaxWidth().horizontalScroll(scroll).padding(horizontal = 16.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        tabs.forEachIndexed { index, title ->
            FilterChip(
                selected = selected == index,
                onClick = { onSelect(index) },
                label = { Text(title, maxLines = 1) },
            )
        }
    }
}

/**
 * Состояние строки модели одним значением: точку, подпись и кнопку рисуют по
 * нему, и разойтись они больше не могут. Файлы важнее статуса: у модели, чьи
 * веса удалили, роутер всё ещё может помнить пресет как «unloaded», а
 * «Запустить» для неё не сработает никогда.
 */
internal enum class ModelState { RUNNING, STARTING, FAILED, GONE, STOPPED }

internal fun modelStateOf(entry: LocalModelEntry): ModelState = when {
    entry.filesPresent == false -> ModelState.GONE
    entry.status == "loaded" || entry.status == "sleeping" -> ModelState.RUNNING
    entry.status == "loading" -> ModelState.STARTING
    entry.status == "failed" -> ModelState.FAILED
    else -> ModelState.STOPPED
}

/** Подпись под именем модели: чем она запускается и с каким контекстом. */
internal fun modelMetaLine(entry: LocalModelEntry, routerProvider: String?): String {
    val group = entry.provider ?: routerProvider ?: "llama.cpp"
    val context = entry.contextWindow
        ?.takeIf { entry.filesPresent != false }
        ?.let { "контекст ${contextLabel(it)}" }
    return listOfNotNull(group, context).joinToString(" · ")
}

/** Вкладка «Установленные»: пресеты роутера llama.cpp и внешние серверы (Strata). */
@Composable
private fun InstalledTab(
    models: List<LocalModelEntry>,
    routerProvider: String?,
    library: List<LibraryEntry>,
    hidden: List<String>,
    busyId: String?,
    onLoad: (String) -> Unit,
    onUnload: (String) -> Unit,
    onSetContext: (String, Long) -> Unit,
    onSetVision: (String, Boolean) -> Unit,
    onForget: (String) -> Unit,
    onUnhide: (String) -> Unit,
    onRegisterLibrary: (String) -> Unit,
    onRunLibrary: (String) -> Unit,
    onDeleteLibrary: (String) -> Unit,
    onOpenHf: () -> Unit,
) {
    var editing by remember { mutableStateOf<LocalModelEntry?>(null) }
    var forgetting by remember { mutableStateOf<LocalModelEntry?>(null) }
    var deleting by remember { mutableStateOf<LibraryEntry?>(null) }

    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        if (models.isEmpty() && hidden.isEmpty()) {
            TabHint(
                AppIcons.Layers,
                "Локальных моделей нет",
                "Скачайте GGUF на вкладке Hugging Face или добавьте пресет в models.ini роутера llama.cpp.",
            ) { Button(onClick = onOpenHf) { Text("Перейти к Hugging Face") } }
        } else {
            Text(
                "запущено ${models.count { modelStateOf(it) == ModelState.RUNNING }} из ${models.size}",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
            )
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                models.forEach { model ->
                    InstallCard(
                        model = model,
                        routerProvider = routerProvider,
                        busyId = busyId,
                        onLoad = { onLoad(model.id) },
                        onUnload = { onUnload(model.id) },
                        onEdit = { editing = model },
                        onSetVision = { onSetVision(model.id, it) },
                        onForget = { forgetting = model },
                    )
                }
            }
        }

        // Скрытые строки не теряются: их вернуть можно отсюда же — иначе скрытие
        // с телефона было бы дверью в одну сторону, чинить только правкой config.json.
        if (hidden.isNotEmpty()) {
            SectionTitle("Скрытые")
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                hidden.forEach { id ->
                    LocalCard {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                id,
                                style = MaterialTheme.typography.bodyMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            TextButton(onClick = { onUnhide(id) }, enabled = busyId == null) { Text("Вернуть") }
                        }
                        Text(
                            "Строка найдена автоматически (Pi и каталог установки) — она спрятана только в списке TaskBridge. " +
                                "Файлы, конфиг движка и models.json Pi не тронуты.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 3,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }

        // Библиотека скачанных с Hugging Face моделей: они есть на диске, но в
        // списке роутера появятся только после «В Pi» и перезапуска роутера —
        // без этого блока скачанное «пропадало» между вкладками.
        if (library.isNotEmpty()) {
            SectionTitle("Скачано с Hugging Face")
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                library.forEach { entry ->
                    LibraryCard(
                        entry = entry,
                        busyId = busyId,
                        onRegister = { onRegisterLibrary(entry.id) },
                        onRun = { onRunLibrary(entry.id) },
                        onEdit = { entry.preset?.let { preset -> editing = LocalModelEntry(id = preset, name = entry.name) } },
                        onDelete = { deleting = entry },
                    )
                }
            }
        }
    }

    editing?.let { model ->
        ContextDialog(
            model = model,
            onDismiss = { editing = null },
            onSave = { value ->
                editing = null
                onSetContext(model.id, value)
            },
        )
    }
    forgetting?.let { model ->
        AlertDialog(
            onDismissRequest = { forgetting = null },
            title = { Text("Убрать ${model.id} из списка?") },
            text = {
                Text(
                    if (model.hideable) {
                        "Строка найдена автоматически (провайдер в Pi и конфиг движка в каталоге установки) — " +
                            "удалять её неоткуда, поэтому она просто не будет показываться в списке TaskBridge " +
                            "(config.json → localRuntime.externalHidden). Файлы модели, конфиг движка и models.json Pi " +
                            "не трогаются. Вернуть можно в разделе «Скрытые» на этом же экране."
                    } else {
                        "Удаляется только запись конфига: строка TaskBridge из config.json " +
                            "(localRuntime.externalServers) или секция пресета в models.ini роутера. " +
                            "Файлы модели, конфиг движка и запущенный процесс не трогаются; если провайдер есть в Pi " +
                            "(~/.pi/agent/models.json), он останется в списке моделей Pi."
                    },
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val id = model.id
                    forgetting = null
                    onForget(id)
                }) { Text("Убрать", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { forgetting = null }) { Text("Отмена") } },
        )
    }
    deleting?.let { entry ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Удалить ${entry.name ?: entry.id}?") },
            text = {
                Text(
                    "С диска удаляются только файлы этой записи. " +
                        "Файлы, общие с другими моделями (например vision-проектор), останутся. " +
                        "Пресет будет убран из models.ini; запущенную модель сначала остановите."
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val id = entry.id
                    deleting = null
                    onDeleteLibrary(id)
                }) { Text("Удалить", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Отмена") } },
        )
    }
}

/** Карточка пресета роутера: имя, чем запускается, прогресс загрузки, действия. */
@Composable
private fun InstallCard(
    model: LocalModelEntry,
    routerProvider: String?,
    busyId: String?,
    onLoad: () -> Unit,
    onUnload: () -> Unit,
    onEdit: () -> Unit,
    onSetVision: (Boolean) -> Unit,
    onForget: () -> Unit,
) {
    val state = modelStateOf(model)
    val pending = busyId == model.id
    LocalCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            StateDot(state)
            Spacer(Modifier.width(8.dp))
            Text(
                model.name ?: model.id,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (pending) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
        }
        Text(
            modelMetaLine(model, routerProvider),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (state == ModelState.STARTING) {
            // Прогресс весов даёт только llama.cpp (сцены загрузки). Внешний
            // сервер поднимается целиком и о ходе не рассказывает — тогда полоса
            // без процента, а не выдуманный ноль.
            val ratio = model.loadRatio
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (ratio == null) {
                    LinearProgressIndicator(Modifier.weight(1f))
                } else {
                    LinearProgressIndicator(progress = { ratio.toFloat() }, modifier = Modifier.weight(1f))
                }
                Spacer(Modifier.width(10.dp))
                Text(
                    if (ratio == null) "запускается" else "запускается · ${(ratio * 100).roundToInt()} %",
                    style = MaterialTheme.typography.labelSmall,
                    color = LocalStatusColors.current.working,
                )
            }
        }
        if (state == ModelState.GONE) {
            Text(
                model.missingFile?.let { "нет файла $it" } ?: "файлов нет",
                style = MaterialTheme.typography.bodySmall,
                color = LocalStatusColors.current.failed,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (state == ModelState.FAILED) {
            Text(
                "ошибка загрузки — подробности в логе роутера",
                style = MaterialTheme.typography.bodySmall,
                color = LocalStatusColors.current.failed,
            )
        }
        // Vision у пресета роутера — это ключ mmproj в его секции models.ini:
        // переключатель показывает и правит ровно то, чем модель видит картинки.
        // Строкам, чей vision задаёт движок или Pi, переключателя не даём.
        if (model.visionEditable) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Switch(
                    checked = model.vision,
                    onCheckedChange = onSetVision,
                    enabled = busyId == null,
                )
                Spacer(Modifier.width(8.dp))
                Text("Vision", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                Spacer(Modifier.width(8.dp))
                Text(
                    if (model.vision) "картинки видит (mmproj)" else "только текст",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        CardActions {
            if (state == ModelState.GONE && (model.removable || model.hideable)) {
                TextButton(onClick = onForget, enabled = busyId == null) { Text("Убрать") }
            }
            if (model.contextEditable) {
                TextButton(onClick = onEdit, enabled = busyId == null) { Text("Контекст") }
            }
            when (state) {
                ModelState.RUNNING -> OutlinedButton(onClick = onUnload, enabled = busyId == null) { Text("Остановить") }
                ModelState.STARTING -> OutlinedButton(onClick = {}, enabled = false) { Text("Запускается…") }
                ModelState.GONE -> Button(onClick = {}, enabled = false) { Text("Запустить") }
                ModelState.FAILED, ModelState.STOPPED -> Button(onClick = onLoad, enabled = busyId == null) {
                    Text(if (pending) "…" else "Запустить")
                }
            }
        }
    }
}

/** Карточка скачанной с Hugging Face модели: она на диске, роутер о ней может ещё не знать. */
@Composable
private fun LibraryCard(
    entry: LibraryEntry,
    busyId: String?,
    onRegister: () -> Unit,
    onRun: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val size = entry.files.sumOf { it.size ?: 0L }
    val state = when {
        entry.preset != null -> "прописана в роутере"
        entry.filesPresent -> "на диске"
        else -> "файлов нет"
    }
    LocalCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                entry.name ?: entry.id,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            // Удаление — в меню: редкое и необратимое действие не должно стоять
            // в одном ряду с «Запустить», куда попадает большой палец.
            Box {
                IconButton(onClick = { menu = true }, modifier = Modifier.size(32.dp)) {
                    Icon(AppIcons.More, "Действия", Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                DropdownMenu(menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(
                        text = { Text("Удалить", color = MaterialTheme.colorScheme.error) },
                        leadingIcon = { Icon(AppIcons.Delete, null, tint = MaterialTheme.colorScheme.error) },
                        enabled = busyId == null,
                        onClick = { menu = false; onDelete() },
                    )
                }
            }
        }
        Text(
            listOfNotNull(
                listOf("Hugging Face", entry.quant).filterNotNull().joinToString(" · "),
                if (size > 0) hfSize(size) else null,
                state,
            ).joinToString(" · "),
            style = MaterialTheme.typography.bodySmall,
            color = if (entry.filesPresent) MaterialTheme.colorScheme.onSurfaceVariant else LocalStatusColors.current.failed,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        CardActions {
            if (entry.preset == null) {
                TextButton(onClick = onRegister, enabled = busyId == null && entry.filesPresent) { Text("В Pi") }
            } else {
                // Пресет уже в models.ini: контекст правится в его секции даже
                // до перезапуска роутера (сервер ищет секцию по файлу весов),
                // а «Запустить» при необходимости сам перезапустит роутер.
                TextButton(onClick = onEdit, enabled = busyId == null) { Text("Контекст") }
                Button(onClick = onRun, enabled = busyId == null) {
                    Text(if (busyId == entry.id) "…" else "Запустить")
                }
            }
        }
    }
}

/** Вкладка «Hugging Face»: поиск → варианты (кванты с размерами) → «Скачать». */
@Composable
private fun HuggingFaceTab(
    query: String,
    onQuery: (String) -> Unit,
    searching: Boolean,
    results: List<HfSearchResult>?,
    repo: HfRepoInfo?,
    repoLoading: Boolean,
    onSearch: () -> Unit,
    onOpenRepo: (String) -> Unit,
    onBackToResults: () -> Unit,
    onDownload: (HfVariant) -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (repo == null) {
            // Кнопка поиска — внутри поля: отдельная кнопка рядом отнимала у
            // поля треть ширины, а «Найти» всё равно читалось как часть строки.
            OutlinedTextField(
                query,
                onQuery,
                Modifier.fillMaxWidth(),
                label = { Text("Поиск GGUF на Hugging Face") },
                singleLine = true,
                trailingIcon = {
                    if (searching) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    else IconButton(onClick = onSearch, enabled = query.isNotBlank()) {
                        Icon(AppIcons.Search, "Найти", Modifier.size(20.dp))
                    }
                },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { if (query.isNotBlank() && !searching) onSearch() }),
            )
            results?.let { found ->
                if (found.isEmpty()) {
                    Text(
                        "Ничего не найдено.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                found.forEach { item ->
                    LocalCard {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    item.repo,
                                    style = MaterialTheme.typography.titleSmall,
                                    fontWeight = FontWeight.Medium,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    "⬇ ${item.downloads} · ♥ ${item.likes}" + if (item.gated) " · gated" else "",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            TextButton(onClick = { onOpenRepo(item.repo) }, enabled = !repoLoading) { Text("Варианты") }
                        }
                    }
                }
            }
        } else {
            TextButton(onClick = onBackToResults) { Text("← К результатам поиска") }
            Text(
                repo.repo,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Medium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (repoLoading) {
                Text(
                    "Читаю репозиторий…",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            repo.variants.forEach { variant ->
                LocalCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(variant.quant, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Medium)
                            val shards = variant.shards?.let { " · $it части" }.orEmpty()
                            val broken = if (variant.complete) "" else " · неполный набор частей"
                            Text(
                                "${hfSize(variant.totalBytes)}$shards$broken",
                                style = MaterialTheme.typography.bodySmall,
                                color = if (variant.complete) MaterialTheme.colorScheme.onSurfaceVariant else LocalStatusColors.current.failed,
                            )
                        }
                        Button(onClick = { onDownload(variant) }, enabled = variant.complete) { Text("Скачать") }
                    }
                }
            }
            if (repo.projectors.isNotEmpty()) {
                Text(
                    "Vision: ${repo.projectors.joinToString(", ") { it.path.substringAfterLast('/') }} — скачается автоматически",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** Вкладка «Загрузки»: очередь DownloadManager с прогрессом, отменой и «В Pi». */
@Composable
private fun DownloadsTab(
    downloads: List<HfDownloadJob>,
    busyJobId: String?,
    onCancel: (String) -> Unit,
    onRetry: (String) -> Unit,
    onRegister: (String) -> Unit,
    onClearFinished: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (downloads.isEmpty()) {
            TabHint(
                AppIcons.ArrowDown,
                "Загрузок нет",
                "Скачанное появится здесь: начните загрузку на вкладке Hugging Face.",
            )
            return@Column
        }
        if (downloads.any { !it.active }) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onClearFinished, enabled = busyJobId == null) { Text("Очистить завершённые") }
            }
        }
        downloads.sortedByDescending { it.active }.forEach { job ->
            DownloadCard(
                job = job,
                busyJobId = busyJobId,
                onCancel = { onCancel(job.id) },
                onRetry = { onRetry(job.id) },
                onRegister = { job.libraryId?.let(onRegister) },
            )
        }
    }
}

/** Карточка задания загрузки: сколько уже скачано, с какой скоростью и что осталось. */
@Composable
private fun DownloadCard(
    job: HfDownloadJob,
    busyJobId: String?,
    onCancel: () -> Unit,
    onRetry: () -> Unit,
    onRegister: () -> Unit,
) {
    val percent = hfPercent(job.downloadedBytes, job.totalBytes)
    val busy = busyJobId == job.id
    LocalCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                job.label ?: job.repo,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            percent?.let {
                Spacer(Modifier.width(8.dp))
                Text(
                    "$it %",
                    style = MaterialTheme.typography.labelLarge,
                    color = if (job.active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        when {
            percent != null -> LinearProgressIndicator(progress = { percent / 100f }, modifier = Modifier.fillMaxWidth())
            job.active -> LinearProgressIndicator(Modifier.fillMaxWidth())
        }
        val speed = job.speed?.takeIf { job.active && it > 0 }
        // Скорость и остаток — одной оговоркой через запятую: с « · » перенос
        // строки оставлял разделитель висеть в конце строки.
        val pace = listOfNotNull(
            speed?.let { "${hfSize(it.toLong())}/с" },
            speed?.let { hfEta(job.totalBytes - job.downloadedBytes, it)?.let { left -> "осталось ~$left" } },
        ).joinToString(", ")
        Text(
            listOfNotNull(
                hfState(job.state),
                "${hfSize(job.downloadedBytes)} из ${hfSize(job.totalBytes)}",
                pace.takeIf { it.isNotEmpty() },
                job.error,
            ).joinToString(" · "),
            style = MaterialTheme.typography.bodySmall,
            color = if (job.state == "FAILED") LocalStatusColors.current.failed else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        CardActions {
            when {
                job.active -> TextButton(onClick = onCancel, enabled = busyJobId == null) { Text("Отменить") }
                job.resumable -> TextButton(onClick = onRetry, enabled = busyJobId == null) { Text("Продолжить") }
                job.state == "INSTALLED" && job.libraryId != null ->
                    TextButton(onClick = onRegister, enabled = busyJobId == null) { Text("В Pi") }
            }
        }
    }
}

/**
 * Подсказка пустой вкладки. Не [ru.arny.taskbridge.ui.common.EmptyState]: тот
 * растягивается на весь родитель, а у прокручиваемой колонки высота
 * бесконечна — при крупном шрифте содержимое обрезалось бы снизу.
 */
@Composable
private fun TabHint(icon: ImageVector, title: String, text: String, action: (@Composable () -> Unit)? = null) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            Modifier.size(56.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primaryContainer),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, null, tint = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.size(26.dp))
        }
        Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        Text(
            text,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        action?.invoke()
    }
}

/** Карточка списка: один и тот же вид у моделей, библиотеки, поиска и загрузок. */
@Composable
private fun LocalCard(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerLow)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        content = content,
    )
}

/**
 * Кнопки карточки — отдельной строкой справа с переносом: на узком экране три
 * кнопки в один ряд не влезают, а выдавливать ими имя модели нельзя.
 */
@Composable
private fun CardActions(content: @Composable FlowRowScope.() -> Unit) {
    FlowRow(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
        verticalArrangement = Arrangement.spacedBy(4.dp),
        content = content,
    )
}

/**
 * Что сказать после переключения vision. Роутер читает models.ini при старте,
 * поэтому «сохранилось» без оговорки читалось бы как «подхватилось сейчас»:
 * эта строка говорит, когда именно.
 */
internal fun visionNote(change: LocalVisionChange): String = buildString {
    append(if (change.vision) "Vision включён" else "Vision выключен")
    change.mmproj?.takeIf { change.vision }?.let { append(" · проектор ${it.substringAfterLast('/').substringAfterLast('\\')}") }
    if (change.changed) {
        append(if (change.restartRequired) " — роутер читает models.ini при старте, перезапустите его" else " — подхватится при следующем запуске роутера")
    }
}

/** Точка состояния — тем же цветом, что и у статусов сессий: палитра в приложении одна. */
@Composable
private fun StateDot(state: ModelState) {
    val color = when (state) {
        ModelState.RUNNING -> LocalStatusColors.current.done
        ModelState.STARTING -> LocalStatusColors.current.working
        ModelState.FAILED, ModelState.GONE -> LocalStatusColors.current.failed
        ModelState.STOPPED -> LocalStatusColors.current.muted
    }
    Box(Modifier.size(8.dp).clip(CircleShape).background(color))
}

/** `262144` → `«262 144»`: шестизначное число без разрядов не прочитать. */
internal fun contextLabel(value: Long): String =
    value.toString().reversed().chunked(3).joinToString(" ").reversed()

/**
 * Процент загрузки: `null` — размер неизвестен (сервер его не сказал), тогда
 * полоса рисуется без числа, а не «0 %» на середине файла.
 */
internal fun hfPercent(downloadedBytes: Long, totalBytes: Long): Int? =
    if (totalBytes > 0) ((downloadedBytes.toDouble() / totalBytes) * 100).roundToInt().coerceIn(0, 100) else null

/** Остаток по последней измеренной скорости — её сервер шлёт только у активного задания. */
internal fun hfEta(remainingBytes: Long, speedBytesPerSecond: Double?): String? {
    val speed = speedBytesPerSecond ?: return null
    if (remainingBytes <= 0 || speed <= 0) return null
    val minutes = (remainingBytes / speed / 60).toLong()
    return when {
        minutes < 1 -> "меньше минуты"
        minutes < 60 -> "$minutes мин"
        minutes % 60 == 0L -> "${minutes / 60} ч"
        else -> "${minutes / 60} ч ${minutes % 60} мин"
    }
}

private fun hfSize(bytes: Long): String = when {
    bytes >= 1_000_000_000 -> "%.1f ГБ".format(bytes / 1e9)
    bytes >= 1_000_000 -> "${bytes / 1_000_000} МБ"
    bytes >= 1_000 -> "${bytes / 1_000} КБ"
    else -> "$bytes Б"
}

private fun hfState(state: String): String = when (state) {
    "QUEUED" -> "в очереди"
    "DOWNLOADING" -> "качается"
    "VERIFYING" -> "проверка"
    "INSTALLED" -> "установлена"
    "FAILED" -> "ошибка"
    "CANCELLED" -> "отменена"
    "INTERRUPTED" -> "прервана рестартом"
    else -> state
}

/** Размер контекста — параметр ЗАГРУЗКИ: менять его можно только на остановленной модели. */
@Composable
private fun ContextDialog(model: LocalModelEntry, onDismiss: () -> Unit, onSave: (Long) -> Unit) {
    val current = model.contextWindow
    var text by remember(model.id) { mutableStateOf(current?.toString().orEmpty()) }
    val parsed = text.trim().toLongOrNull()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Контекст модели") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "${model.id}. Контекст задаётся при загрузке: новое значение подхватит следующая загрузка (сейчас ${current?.let(::contextLabel) ?: "неизвестен"}).",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it.filter(Char::isDigit) },
                    label = { Text("Токенов") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
                // Четыре значения — уже шире телефона: Row выдавил бы последнее в ноль.
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(32768L, 65536L, 131072L, 262144L).forEach { preset ->
                        FilterChip(
                            selected = parsed == preset,
                            onClick = { text = preset.toString() },
                            label = { Text(contextLabel(preset)) },
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { parsed?.let(onSave) }, enabled = parsed != null && parsed != current) { Text("Сохранить") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Отмена") } },
    )
}
