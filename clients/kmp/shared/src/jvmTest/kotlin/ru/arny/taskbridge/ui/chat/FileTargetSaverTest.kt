package ru.arny.taskbridge.ui.chat

import androidx.compose.runtime.saveable.SaverScope
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class FileTargetSaverTest {
    @Test
    fun restoresWorkspaceAndAttachmentIdentityWithoutSavingImageBytes() {
        val scope = SaverScope { true }
        listOf(FileTarget.Workspace("images/длинная картинка.png"), FileTarget.Attachment("id-123", "photo.jpg")).forEach { target ->
            val saved = with(FileTargetSaver) { scope.save(target) }
            assertEquals(target, FileTargetSaver.restore(assertNotNull(saved)))
        }
    }
}
