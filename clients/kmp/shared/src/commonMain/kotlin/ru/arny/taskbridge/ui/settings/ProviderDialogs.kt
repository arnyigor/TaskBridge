package ru.arny.taskbridge.ui.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import ru.arny.taskbridge.AppGraph

/**
 * Форма подключения к провайдеру — одна на «Настройки» и «Модели Pi».
 *
 * Одна запись `models.json` правится в двух местах, и форма должна быть одна,
 * иначе они расходятся в поведении. Хост читает состояние контроллера сам,
 * поэтому вызывающему не нужно протаскивать десяток параметров и нельзя забыть
 * одно из полей.
 *
 * @param onClosed вызывается, когда диалог закрылся: экран, у которого свой
 * список провайдеров (модели Pi), перечитывает его после записи файла.
 * @param onOpenRaw полный JSON записи — у экрана «Модели Pi» он есть, в настройках нет.
 */
@Composable
internal fun ProviderDialogs(
    connection: AppGraph.Connected,
    onClosed: () -> Unit = {},
    onOpenRaw: ((String) -> Unit)? = null,
) {
    val state by connection.settingsController.state.collectAsState()
    val editor = state.providerEditor
    var wasOpen by remember { mutableStateOf(false) }
    LaunchedEffect(editor) {
        if (editor == null && wasOpen) onClosed()
        wasOpen = editor != null
    }

    editor?.let { current ->
        ProviderEditorDialog(
            editor = current,
            draft = state.providerDraft,
            busy = state.providerBusy,
            onChange = connection.settingsController::updateProviderEditor,
            onDraftCheck = { connection.settingsController.checkProviderDraft(current.baseUrl.trim(), current.keyEnv.trim()) },
            onAddModel = connection.settingsController::addDiscoveredModel,
            onRemoveModel = { model -> connection.settingsController.removeModelFromDraft(model) },
            onSave = connection.settingsController::saveProviderEditor,
            onDismiss = connection.settingsController::closeProviderEditor,
            onOpenRaw = onOpenRaw?.let { open -> ({ open(current.id) }) },
        )
    }
}
