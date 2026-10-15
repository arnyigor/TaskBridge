package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.TextField
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performTextInput
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.chat.ToolCall
import ru.arny.taskbridge.core.client.chat.ToolState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.unit.dp
import java.security.MessageDigest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@OptIn(ExperimentalTestApi::class)
class HeavyReasoningCopyTest {
    @Test
    fun mixedChatKeepsComposerAndFullReasoningCopyUsable() = runComposeUiTest {
        val reasoning = " \n" + "Проверка reasoning, bash и изменений файлов\n".repeat(6_000) + "\n "
        val tools = List(120) { index ->
            val kind = listOf("bash", "edit", "read", "write")[index % 4]
            ToolCall("tool-$index", kind, "operation $index", ToolState.DONE,
                if (kind == "bash") null else "src/file$index.kt", changePreview = if (kind == "edit") "- old\n+ new" else null)
        }
        val answers = List(8) { index ->
            ChatItem.Assistant("answer-$index", "Ответ $index\n\n```kotlin\nval result = $index\n```", reasoning,
                tools, active = false, status = "SUCCEEDED", error = null, final = true, at = null,
                endedAt = null, partial = false, superseded = false, stopReason = null, variants = null)
        }
        var copied: String? = null
        var draft by mutableStateOf("")
        setContent {
            MaterialTheme {
                Column(Modifier.width(480.dp).fillMaxHeight()) {
                    LazyColumn(Modifier.weight(1f).testTag("mixed-history")) {
                        items(answers, key = { it.id }) { answer ->
                            AssistantMessage(answer, "", MessageActions(copy = {}), onCopyText = { copied = it },
                                loadToolOutput = { error("collapsed tools must not load output") }, onOpenPath = {},
                                onSelectVariant = {}, onOpenFile = { _, _ -> }, loadFile = { error("unused") },
                                loadWorkspaceFile = { error("unused") })
                        }
                    }
                    TextField(draft, onValueChange = { draft = it }, modifier = Modifier.testTag("mixed-composer"))
                }
            }
        }
        repeat(2) {
            onNodeWithTag("mixed-history").performScrollToIndex(7)
            onNodeWithTag("mixed-composer").performTextInput("ввод $it ")
            onNodeWithTag("mixed-history").performScrollToIndex(0)
        }
        assertEquals("ввод 0 ввод 1 ", draft)
        onAllNodesWithText("Размышления · ${reasoning.length} симв.").onFirst().performClick()
        onNodeWithContentDescription("Копировать размышления").performClick()
        assertEquals(reasoning, copied)
        onNodeWithText("Свернуть").performClick()
        onNodeWithTag("mixed-composer").performTextInput("после копирования")
        assertTrue(draft.endsWith("после копирования"))
    }

    @Test
    fun expandedPreviewStaysBoundedButCopyPreservesTheEntireOriginal() = runComposeUiTest {
        val original = "  \n" + "Рассуждение о коде и командах\n".repeat(9_000) + "\n  "
        assertTrue(original.length > 200_000)
        var copied: String? = null
        setContent {
            MaterialTheme {
                Box(Modifier.width(380.dp)) {
                    ThinkingBlock(original, streaming = false, onCopy = { copied = it })
                }
            }
        }
        onNodeWithText("Размышления · ${original.length} симв.").performClick()
        onNodeWithContentDescription("Копировать размышления").performClick()
        assertEquals(original.length, copied?.length)
        fun sha256(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).toList()
        assertEquals(sha256(original), sha256(copied!!))
        assertTrue(onAllNodesWithText(original).fetchSemanticsNodes().isEmpty(), "full reasoning must not be laid out")
        onNodeWithText("Свернуть").performClick()
        onNodeWithContentDescription("Копировать размышления").assertDoesNotExist()
    }
}
