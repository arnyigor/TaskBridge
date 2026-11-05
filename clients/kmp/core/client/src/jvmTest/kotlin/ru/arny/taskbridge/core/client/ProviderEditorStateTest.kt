package ru.arny.taskbridge.core.client

import ru.arny.taskbridge.core.client.settings.ProviderEditorState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Форма подключения провайдера: проверяется то, что решает, уйдёт ли запись в
 * models.json. Сервер откажет в том же — дублировать его валидацию целиком
 * незачем, но кнопка «Сохранить» не должна отправлять заведомый отказ.
 */
class ProviderEditorStateTest {

    private fun editor(
        id: String = "tb-demo",
        baseUrl: String = "https://api.example/v1",
        models: String = "m1\nm2",
        keyEnv: String = "DEMO_KEY",
    ) = ProviderEditorState(id = id, baseUrl = baseUrl, models = models, keyEnv = keyEnv)

    @Test
    fun `a filled managed identifier with models is ready to save`() {
        assertTrue(editor().ready)
    }

    @Test
    fun `models are trimmed and deduplicated`() {
        assertEquals(listOf("m1", "m2"), editor(models = " m1 \n\nm2\nm1").modelIds)
    }

    @Test
    fun `identifier must stay inside the tb prefix the server accepts`() {
        assertFalse(editor(id = "deepseek").ready, "чужую запись нельзя присвоить")
        assertFalse(editor(id = "tb-").ready)
        assertFalse(editor(id = "tb-demo/../x").ready)
        assertTrue(editor(id = "tb-my-provider").ready)
    }

    @Test
    fun `no address or no model is not ready`() {
        assertFalse(editor(baseUrl = " ").ready)
        assertFalse(editor(models = "\n \n").ready)
        assertFalse(editor(keyEnv = "").ready, "для публичного API нужен ключ")
    }
}
