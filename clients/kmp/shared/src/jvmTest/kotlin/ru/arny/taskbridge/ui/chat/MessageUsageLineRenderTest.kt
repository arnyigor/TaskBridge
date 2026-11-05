package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.unit.dp
import ru.arny.taskbridge.core.client.chat.ChatItem
import kotlin.test.Test

/**
 * Строка расхода под ответом: видна, помечается при пике и не занимает места,
 * когда считать нечего (локальная модель, прерванный вызов).
 */
@OptIn(ExperimentalTestApi::class)
class MessageUsageLineRenderTest {
    private fun answer() = ChatItem.Assistant(
        "assistant-initial", "Ответ", "", emptyList(), active = false, status = "SUCCEEDED", error = null,
        final = true, at = null, endedAt = null, partial = false, superseded = false, stopReason = null, variants = null,
    )

    private fun actions() = MessageActions(copy = {})

    @Test
    fun usageLineAndPeakBadgeAreShownUnderTheAnswer() = runComposeUiTest {
        setContent {
            MaterialTheme {
                Box(Modifier.width(360.dp)) {
                    AssistantMessage(
                        item = answer(),
                        time = "14:32 · 1 мин 20 с",
                        actions = actions(),
                        onCopyText = {},
                        loadToolOutput = { error("unused") },
                        onOpenPath = {},
                        onSelectVariant = {},
                        onOpenFile = { _, _ -> },
                        loadFile = { error("unused") },
                        loadWorkspaceFile = { error("unused") },
                        desktop = false,
                        usageLine = "2.4M ток · $0.0277 · ≈ 2.23 ₽",
                        usagePeak = true,
                    )
                }
            }
        }
        onNodeWithText("2.4M ток · $0.0277 · ≈ 2.23 ₽").assertExists()
        onNodeWithText("пик ×2").assertExists()
    }

    @Test
    fun noPeakBadgeAndNoLineWithoutUsage() = runComposeUiTest {
        setContent {
            MaterialTheme {
                Box(Modifier.width(360.dp)) {
                    AssistantMessage(
                        item = answer(),
                        time = "14:32",
                        actions = actions(),
                        onCopyText = {},
                        loadToolOutput = { error("unused") },
                        onOpenPath = {},
                        onSelectVariant = {},
                        onOpenFile = { _, _ -> },
                        loadFile = { error("unused") },
                        loadWorkspaceFile = { error("unused") },
                        desktop = false,
                        usageLine = "2.4M ток · $0.0138 · ≈ 1.12 ₽",
                        usagePeak = false,
                    )
                }
            }
        }
        onNodeWithText("2.4M ток · $0.0138 · ≈ 1.12 ₽").assertExists()
        onNodeWithText("пик ×2").assertDoesNotExist()
    }
}
