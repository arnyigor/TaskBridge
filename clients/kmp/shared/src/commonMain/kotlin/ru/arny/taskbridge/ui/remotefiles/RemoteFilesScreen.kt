package ru.arny.taskbridge.ui.remotefiles

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ru.arny.taskbridge.AppGraph
import ru.arny.taskbridge.core.api.RemoteFilePreview
import ru.arny.taskbridge.core.client.remotefiles.RemoteFilesController
import ru.arny.taskbridge.core.client.remotefiles.RemoteFilesEvent
import ru.arny.taskbridge.core.client.remotefiles.RemoteFilesState
import ru.arny.taskbridge.ui.chat.decodeImage
import ru.arny.taskbridge.ui.theme.AppIcons
import kotlin.io.encoding.Base64

private val permissionLabels = linkedMapOf(
    "browse" to "Просматривать список файлов",
    "preview" to "Предпросмотр пользователем",
    "attach-file" to "Создавать вложения-снимки",
    "agent-read" to "Разрешить агенту читать папку",
    "model-transfer" to "Разрешить передачу файлов и имён выбранной модели (в том числе облачной)",
)

/** A separate route; the controller never borrows ChatScreen/ProjectWorkspace state. */
@Composable
fun RemoteFilesScreen(
    graph: AppGraph,
    connection: AppGraph.Connected,
    projectId: String,
    taskId: String? = null,
    rootId: String? = null,
    path: String = "",
    onLocation: (String?, String) -> Unit,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val controller = remember(connection, projectId, taskId) {
        RemoteFilesController(connection.api, projectId, taskId, scope, rootId, path)
    }
    val state by controller.state.collectAsStateWithLifecycle()
    val online by connection.online.collectAsStateWithLifecycle()
    val foreground by connection.visible.collectAsStateWithLifecycle()
    val locationCallback by rememberUpdatedState(onLocation)
    val backCallback by rememberUpdatedState(onBack)
    LaunchedEffect(controller, online) { controller.setOnline(online) }
    LifecycleStartEffect(controller, foreground) {
        if (foreground) controller.show() else controller.hide()
        onStopOrDispose { controller.hide() }
    }
    LaunchedEffect(controller) {
        controller.events.collect { event ->
            when (event) {
                is RemoteFilesEvent.Location -> locationCallback(event.rootId, event.path)
                RemoteFilesEvent.Sent -> backCallback()
            }
        }
    }
    RemoteFilesContent(state, controller, onBack,
        chooseFolder = { graph.platform.chooseProjectFolder()?.let(controller::editOperatorPath) },
        canChooseFolder = graph.platform.kind == "desktop",
    )
}

@Composable
private fun RemoteFilesContent(
    state: RemoteFilesState,
    controller: RemoteFilesController,
    onBack: () -> Unit,
    chooseFolder: () -> Unit,
    canChooseFolder: Boolean,
) {
    Scaffold(topBar = {
        TopAppBar(
            title = { Column { Text("Папки компьютера"); Text("Windows · TaskBridge Server", style = MaterialTheme.typography.labelSmall) } },
            navigationIcon = { IconButton(onClick = onBack) { Icon(AppIcons.Back, "Назад") } },
            actions = { IconButton(onClick = controller::refresh, enabled = state.canAct) { Icon(AppIcons.Refresh, "Обновить папки") } },
        )
    }) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Text("Файлы находятся на компьютере. Просмотр пользователем не выдаёт агенту доступ.", style = MaterialTheme.typography.bodySmall) }
            if (!state.online) item { Text("Нет соединения. Операции отключены; содержимое файлов не сохранено.", color = MaterialTheme.colorScheme.error) }
            state.error?.let { error -> item { Text(error, color = MaterialTheme.colorScheme.error) } }
            if (state.loading || state.busy) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            if (state.rootId == null) {
                items(state.settings.roots, key = { it.id }) { root ->
                    OutlinedCard(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(root.name, style = MaterialTheme.typography.titleMedium)
                            Text(if (root.revoked) "Разрешение отозвано локально" else if (!root.available) "Сохранена, но недоступна на сервере" else if (!root.enabled) "Доступ временно отключён" else "Каталог доступен")
                            Text("Просмотр: ${if (root.canBrowse) "да" else "нет"} · Агент: ${if (root.agentCanRead) "да" else "нет"}", style = MaterialTheme.typography.bodySmall)
                            Text("Передача модели: ${if (root.allowModelTransfer) "разрешена" else "запрещена"}", style = MaterialTheme.typography.bodySmall)
                            FlowRow {
                                TextButton(onClick = { controller.navigate(root.id) }, enabled = state.canAct && root.canBrowse && root.available) { Text("Открыть") }
                                TextButton(onClick = { controller.toggle(root) }, enabled = state.canAct && !root.revoked) { Text(if (root.enabled) "Отключить временно" else "Включить") }
                                if (state.settings.localOperator && !root.revoked) TextButton(onClick = { controller.selectRevoke(root) }, enabled = state.canAct) { Text("Отозвать разрешение") }
                            }
                        }
                    }
                }
                if (state.settings.roots.isEmpty() && !state.loading) item { Text("Разрешённых папок пока нет. Отправьте запрос локальному оператору Windows.") }
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Запросить новый доступ", style = MaterialTheme.typography.titleMedium)
                        OutlinedTextField(state.requestPath, controller::editRequestPath, label = { Text("Папка на компьютере или описание, например Downloads") }, modifier = Modifier.fillMaxWidth(), enabled = state.canAct)
                        permissionLabels.forEach { (permission, label) ->
                            Row {
                                Checkbox(permission in state.requestedPermissions, { controller.permission(permission, it) }, enabled = state.canAct)
                                Text(label, modifier = Modifier.weight(1f).padding(top = 12.dp))
                            }
                        }
                        Text("Новые права подтверждаются только на Windows. Передача модели — отдельное согласие.", style = MaterialTheme.typography.bodySmall)
                        Button(onClick = controller::request, enabled = state.canAct && state.requestPath.isNotBlank() && state.requestedPermissions.isNotEmpty()) { Text("Отправить запрос") }
                    }
                }
                items(state.settings.requests, key = { it.id }) { request ->
                    OutlinedCard(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(12.dp)) {
                            Text("Запрос ${request.id.take(8)} · ${request.status}")
                            request.requestedPath?.let { Text(it) }
                            request.requestedPermissions.forEach { Text(permissionLabels[it] ?: it, style = MaterialTheme.typography.bodySmall) }
                            if (state.settings.localOperator && request.status == "PENDING") {
                                TextButton(onClick = { controller.review(request) }, enabled = state.canAct) { Text("Проверить локально") }
                            }
                        }
                    }
                }
            } else {
                item {
                    Column {
                        TextButton(onClick = { controller.navigate(null) }, enabled = state.canAct) { Text("Все папки компьютера") }
                        Text("${state.root?.name ?: state.rootId} / ${state.path}", style = MaterialTheme.typography.titleMedium)
                        if (state.path.isNotEmpty()) TextButton(onClick = { controller.navigate(state.rootId, state.path.substringBeforeLast('/', "")) }, enabled = state.canAct) { Text("На уровень вверх") }
                        OutlinedTextField(state.query, controller::editQuery, label = { Text("Поиск по имени в этом корне") }, modifier = Modifier.fillMaxWidth(), enabled = state.canAct)
                        TextButton(onClick = controller::search, enabled = state.canAct && state.query.isNotBlank()) { Text("Найти (ограниченный поиск)") }
                        state.searchSummary?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    }
                }
                items(state.entries, key = { it.path }) { entry ->
                    OutlinedCard(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(8.dp)) {
                            Text(entry.name, style = MaterialTheme.typography.titleSmall)
                            entry.size?.let { Text("$it Б", style = MaterialTheme.typography.bodySmall) }
                            FlowRow {
                                if (entry.type == "directory") TextButton(onClick = { controller.navigate(state.rootId, entry.path) }, enabled = state.canAct) { Text("Открыть папку") }
                                else {
                                    TextButton(onClick = { controller.preview(entry) }, enabled = state.canAct && entry.previewAvailable) { Text("Предпросмотр") }
                                    if (state.taskId != null) TextButton(onClick = { controller.prepare(entry) }, enabled = state.canAct && state.root?.canAttach == true && state.root?.allowModelTransfer == true && (entry.size ?: Long.MAX_VALUE) <= 2097152) { Text("Прикрепить снимок") }
                                }
                            }
                        }
                    }
                }
                if (state.entries.isEmpty() && !state.loading) item { Text("В проверенной области нет доступных записей.") }
                if (state.nextCursor != null) item { TextButton(onClick = controller::loadMore, enabled = state.canAct) { Text("Загрузить ещё") } }
            }
        }
    }
    state.revoking?.let { root ->
        AlertDialog(onDismissRequest = { if (!state.busy) controller.selectRevoke(null) }, title = { Text("Отозвать разрешение ${root.name}?") },
            text = { Text("Это не временное отключение. Телефон не сможет включить доступ обратно. Новые права потребуют нового локального подтверждения. Неотправленные снимки также станут недоступны.") },
            confirmButton = { TextButton(onClick = controller::revoke, enabled = state.canAct) { Text("Отозвать навсегда") } },
            dismissButton = { TextButton(onClick = { controller.selectRevoke(null) }, enabled = !state.busy) { Text("Отмена") } })
    }
    state.preview?.let { RemotePreviewDialog(it, controller::dismissPreview) }
    state.review?.let { request ->
        AlertDialog(onDismissRequest = { if (!state.busy) controller.review(null) }, title = { Text("Локальное подтверждение Windows") }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Проверьте каталог и каждое полномочие. Телефон не может подтвердить этот запрос.")
                request.requestedPermissions.forEach { Text(permissionLabels[it] ?: it) }
                OutlinedTextField(state.operatorPath, controller::editOperatorPath, label = { Text("Реальный разрешённый каталог Windows") }, enabled = state.canAct)
                if (canChooseFolder) TextButton(onClick = chooseFolder, enabled = state.canAct) { Text("Выбрать папку на этом компьютере") }
            }
        }, confirmButton = { TextButton(onClick = { controller.decide(true) }, enabled = state.canAct && state.operatorPath.isNotBlank()) { Text("Подтвердить права") } },
            dismissButton = { TextButton(onClick = { controller.decide(false) }, enabled = state.canAct) { Text("Отклонить") } })
    }
    state.prepared?.let { upload ->
        AlertDialog(onDismissRequest = { if (!state.busy) controller.dismissAttachment() }, title = { Text("Отправить снимок в этот чат?") }, text = {
            Column {
                Text(upload.files.joinToString { it.name.orEmpty() })
                Text("Снимок уже подготовлен на сервере, без скачивания на телефон. Срок действия — один час.")
                OutlinedTextField(state.attachmentText, controller::editAttachmentText, label = { Text("Сообщение агенту (необязательно)") }, enabled = state.canAct)
            }
        }, confirmButton = { TextButton(onClick = controller::sendAttachment, enabled = state.canAct) { Text("Отправить в чат") } },
            dismissButton = { TextButton(onClick = controller::dismissAttachment, enabled = !state.busy) { Text("Отмена") } })
    }
}

@Composable
private fun RemotePreviewDialog(preview: RemoteFilePreview, onDismiss: () -> Unit) {
    val bitmap = remember(preview) { preview.base64?.let { runCatching { decodeImage(Base64.decode(it)) }.getOrNull() } }
    AlertDialog(onDismissRequest = onDismiss, title = { Text(preview.name) }, text = {
        if (preview.image && bitmap != null) Image(bitmap, "Предпросмотр ${preview.name}", Modifier.fillMaxWidth().heightIn(max = 400.dp))
        else SelectionContainer { Text(preview.text ?: "Изображение не удалось декодировать", Modifier.heightIn(max = 400.dp).verticalScroll(rememberScrollState())) }
    }, confirmButton = { TextButton(onClick = onDismiss) { Text("Закрыть") } })
}
