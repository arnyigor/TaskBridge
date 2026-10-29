package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.test.hasProgressBarRangeInfo
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.unit.dp
import ru.arny.taskbridge.core.client.chat.ChatItem
import kotlin.test.Test

/**
 * Телефонный вид ответа по требованию оператора (2026-10-29):
 * в строке — «Копировать», «Исправить» и «Продолжить» иконками, а ветки, удаление и
 * регенерация — текстом в меню, без дублей; «Повторить с параметрами» убрано совсем
 * (выбор модели есть в меню сессии).
 */
@OptIn(ExperimentalTestApi::class)
class MessageActionTargetTest {
    private fun answer() = ChatItem.Assistant(
        "assistant-1", "Ответ", "", emptyList(), active = false, status = "CANCELLED", error = null,
        final = true, at = null, endedAt = null, partial = false, superseded = false, stopReason = null, variants = null,
    )

    private fun allActions() = MessageActions(
        copy = {}, edit = {}, fork = {}, forkFrom = {}, deleteFrom = {},
        regenerate = {}, continueAnswer = {},
    )

    @Test
    fun phoneRowKeepsUnderstandableIconsAndHidesTheRestInTheMenu() = runComposeUiTest {
        setContent {
            MaterialTheme {
                Box(Modifier.width(360.dp)) {
                    AssistantMessage(
                        item = answer(),
                        time = "08:42 · 26 мин 58 с",
                        actions = allActions(),
                        onCopyText = {},
                        loadToolOutput = { error("unused") },
                        onOpenPath = {},
                        onSelectVariant = {},
                        onOpenFile = { _, _ -> },
                        loadFile = { error("unused") },
                        loadWorkspaceFile = { error("unused") },
                        desktop = false,
                    )
                }
            }
        }
        for (label in listOf("Копировать", "Исправить ответ", "Продолжить ответ", "Действия с ответом")) {
            onNodeWithContentDescription(label).assertWidthIsAtLeast(40.dp).assertHeightIsAtLeast(40.dp)
        }
        // Ветки, удаление, регенерация и «с параметрами» в строке не стоят.
        for (label in listOf("Новая ветка: история до этого ответа", "Удалить ответ и всё ниже", "Ответить заново", "Повторить с параметрами")) {
            onNodeWithContentDescription(label).assertDoesNotExist()
        }
        onNodeWithContentDescription("Действия с ответом").performClick()
        onNodeWithText("Новая ветка: до этого сообщения").assertExists()
        onNodeWithText("Удалить вопрос с ответом и ниже").assertExists()
        onNodeWithText("Ответить заново").assertExists()
        // Меню не повторяет то, что уже иконками.
        onNodeWithText("Копировать").assertDoesNotExist()
        onNodeWithText("Продолжить ответ").assertDoesNotExist()
        onNodeWithText("Повторить с параметрами").assertDoesNotExist()
    }

    @Test
    fun pendingContinueShowsProgressInsteadOfASilentTap() = runComposeUiTest {
        setContent {
            MaterialTheme {
                Box(Modifier.width(360.dp)) {
                    AssistantMessage(
                        item = answer(),
                        time = "",
                        actions = allActions(),
                        onCopyText = {},
                        loadToolOutput = { error("unused") },
                        onOpenPath = {},
                        onSelectVariant = {},
                        onOpenFile = { _, _ -> },
                        loadFile = { error("unused") },
                        loadWorkspaceFile = { error("unused") },
                        desktop = false,
                        continuePending = true,
                    )
                }
            }
        }
        onNodeWithContentDescription("Продолжить ответ").assertDoesNotExist()
        onNode(hasProgressBarRangeInfo(ProgressBarRangeInfo.Indeterminate)).assertExists()
    }
}
