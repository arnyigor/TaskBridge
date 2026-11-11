package ru.arny.taskbridge.ui.settings

import ru.arny.taskbridge.core.client.settings.ProviderEditorState
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Кнопка «Сохранить» в форме подключения.
 *
 * Регрессия: условие содержало `!editor.existing`, поэтому у существующего
 * подключения она была выключена всегда — убрать модель из `models.json` через
 * форму было нельзя. Штатный сборщик сервера принимает такую правку (меняются
 * только модели), и условие кнопки должно совпадать с проверкой
 * `SettingsController.saveProviderEditor`, иначе кнопка включается, а нажатие
 * молча ничего не делает.
 */
class ProviderSaveEnabledTest {

    @AfterTest
    fun clearExistingModels() {
        // Список моделей сохранённого подключения — статическое поле черновика.
        ProviderEditorState.modelIdsFromExisting = emptyList()
    }

    private fun existing(models: String) = ProviderEditorState(
        existing = true,
        id = "tb-demo",
        baseUrl = "https://api.example/v1",
        keyEnv = "DEMO_KEY",
        models = models,
    )

    @Test
    fun existingConnectionWithModelsCanBeSaved() {
        assertTrue(providerSaveEnabled(existing(models = "m1"), working = false))
    }

    @Test
    fun removingEveryModelDisablesSaving() {
        ProviderEditorState.modelIdsFromExisting = listOf("m1")
        val editor = existing(models = "").copy(removedModelIds = setOf("m1"))
        assertFalse(providerSaveEnabled(editor, working = false), "запись без моделей сервер не примет")
    }

    @Test
    fun newConnectionNeedsAddressAndModels() {
        val ready = ProviderEditorState(id = "tb-x", baseUrl = "http://127.0.0.1:8083/v1", models = "m1")
        assertTrue(providerSaveEnabled(ready, working = false))
        assertFalse(providerSaveEnabled(ready.copy(models = ""), working = false))
        assertFalse(providerSaveEnabled(ready.copy(baseUrl = ""), working = false))
    }

    @Test
    fun aRowThatCannotBeSavedStaysDisabledEvenWhenItLooksFilled() {
        // Формат ID, который сервер не примет (заглавные буквы): кнопка выключена.
        val malformed = ProviderEditorState(existing = true, id = "Demo-1", baseUrl = "https://api.example/v1", keyEnv = "K", models = "m1")
        assertFalse(providerSaveEnabled(malformed, working = false))
    }

    @Test
    fun savingInFlightBlocksSecondPress() {
        assertFalse(providerSaveEnabled(existing(models = "m1"), working = true))
    }
}
