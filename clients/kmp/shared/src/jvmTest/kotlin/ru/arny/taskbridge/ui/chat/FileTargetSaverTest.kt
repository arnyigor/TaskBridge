package ru.arny.taskbridge.ui.chat

import androidx.compose.runtime.saveable.SaverScope
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class FileTargetSaverTest {
    @Test
    fun restoresWorkspaceAndAttachmentIdentityWithoutSavingImageBytes() {
        val scope = SaverScope { true }
        // Диапазон строк — часть адреса просмотрщика: восстановленный экран обязан
        // открыться на тех же строках, а не с начала файла (пункт 162).
        listOf(
            FileTarget.Workspace("images/длинная картинка.png"),
            FileTarget.Workspace("src/a.kt", line = 120, endLine = 140),
            FileTarget.Attachment("id-123", "photo.jpg"),
        ).forEach { target ->
            val saved = with(FileTargetSaver) { scope.save(target) }
            assertEquals(target, FileTargetSaver.restore(assertNotNull(saved)))
        }
    }
}
