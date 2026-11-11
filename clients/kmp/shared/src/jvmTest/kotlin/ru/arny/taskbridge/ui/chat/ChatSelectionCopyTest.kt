package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.MouseButton
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performMouseInput
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.text.input.TextFieldValue
import ru.arny.taskbridge.core.client.chat.ChatItem
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

/**
 * Выделение текста в чате на десктопе.
 *
 * Compose обрабатывает Ctrl+C только когда клавиатурный фокус стоит внутри
 * SelectionContainer (`SelectionManager.modifier.onKeyEvent` живёт на пути фокуса), а
 * двойной клик по слову — только когда tap-детектор над текстом не съедает отпускание.
 * Оба условия ломал `Modifier.clickable`, который висел на сообщении всегда, хотя нужен
 * лишь для режима выбора нескольких сообщений.
 */
@OptIn(ExperimentalTestApi::class)
class ChatSelectionCopyTest {

    private val message = "Скопируй меня целиком и сразу"

    private fun readClipboard(): String = try {
        (java.awt.Toolkit.getDefaultToolkit().systemClipboard.getContents(null)
            .getTransferData(java.awt.datatransfer.DataFlavor.stringFlavor) as? String).orEmpty()
    } catch (e: Throwable) {
        "ERR:" + e.message
    }

    /**
     * Композиция чата: пузырь пользователя и поле ввода, которое держит фокус —
     * как в живом окне после открытия сессии.
     */
    private fun androidx.compose.ui.test.ComposeUiTest.composeChat(selectionMode: Boolean) = setContent {
        MaterialTheme {
            val field = remember { FocusRequester() }
            var value = remember { mutableStateOf(TextFieldValue("")) }
            Column(Modifier.fillMaxSize()) {
                UserBubble(
                    item = ChatItem.User(
                        id = "user-1",
                        text = message,
                        files = emptyList(),
                        at = "2026-10-20T12:00:00Z",
                        pending = false,
                        clientId = "desktop",
                        mode = "prompt",
                        turnId = "turn-1",
                    ),
                    time = "12:00",
                    source = null,
                    actions = MessageActions(
                        copy = {},
                        onToggleSelect = if (selectionMode) ({}) else null,
                    ),
                    onOpenFile = { _, _ -> },
                    loadFile = { Result.failure(IllegalStateException("no files")) },
                    desktop = true,
                )
                BasicTextField(
                    value = value.value,
                    onValueChange = { value.value = it },
                    modifier = Modifier.focusRequester(field).testTag("composer"),
                )
                LaunchedEffect(Unit) { runCatching { field.requestFocus() } }
            }
        }
    }

    private fun androidx.compose.ui.test.ComposeUiTest.pressCtrlC() {
        onNodeWithTag("composer", useUnmergedTree = true).performKeyInput {
            keyDown(Key.CtrlLeft)
            keyDown(Key.C)
            keyUp(Key.C)
            keyUp(Key.CtrlLeft)
        }
    }

    @Test
    fun dragSelectionCopiesByCtrlC() = runComposeUiTest {
        composeChat(selectionMode = false)
        waitForIdle()
        java.awt.Toolkit.getDefaultToolkit().systemClipboard
            .setContents(java.awt.datatransfer.StringSelection("sentinel"), null)

        onNodeWithText(message, useUnmergedTree = true).performMouseInput {
            moveTo(center)
            press(MouseButton.Primary)
            moveTo(center + Offset(160f, 0f))
            release(MouseButton.Primary)
        }
        waitForIdle()
        pressCtrlC()
        waitForIdle()

        assertNotEquals("sentinel", readClipboard(), "Ctrl+C после выделения мышью должен заполнить буфер")
    }

    @Test
    fun doubleClickSelectsSingleWord() = runComposeUiTest {
        composeChat(selectionMode = false)
        waitForIdle()
        java.awt.Toolkit.getDefaultToolkit().systemClipboard
            .setContents(java.awt.datatransfer.StringSelection("sentinel"), null)

        onNodeWithText(message, useUnmergedTree = true).performMouseInput {
            moveTo(center)
            press(MouseButton.Primary)
            release(MouseButton.Primary)
            press(MouseButton.Primary)
            release(MouseButton.Primary)
        }
        waitForIdle()
        pressCtrlC()
        waitForIdle()

        assertEquals("целиком", readClipboard(), "двойной клик должен выделить слово под курсором")
    }

    @Test
    fun dragSelectionInAnswerCopiesByCtrlC() = runComposeUiTest {
        setContent {
            MaterialTheme {
                val field = remember { FocusRequester() }
                var value = remember { mutableStateOf(TextFieldValue("")) }
                Column(Modifier.fillMaxSize()) {
                    AssistantMessage(
                        item = ChatItem.Assistant(
                            id = "a1",
                            text = message,
                            thinking = "",
                            tools = emptyList(),
                            active = false,
                            status = "SUCCEEDED",
                            error = null,
                            final = true,
                            at = null,
                            endedAt = null,
                            partial = false,
                            superseded = false,
                            stopReason = null,
                            variants = null,
                        ),
                        time = "12:00",
                        actions = MessageActions(copy = {}),
                        onCopyText = {},
                        loadToolOutput = { Result.failure(IllegalStateException("no tools")) },
                        onOpenPath = {},
                        onSelectVariant = {},
                        onOpenFile = { _, _ -> },
                        loadFile = { Result.failure(IllegalStateException("no files")) },
                        loadWorkspaceFile = { Result.failure(IllegalStateException("no files")) },
                        desktop = true,
                    )
                    BasicTextField(
                        value = value.value,
                        onValueChange = { value.value = it },
                        modifier = Modifier.focusRequester(field).testTag("composer"),
                    )
                    LaunchedEffect(Unit) { runCatching { field.requestFocus() } }
                }
            }
        }
        waitForIdle()
        java.awt.Toolkit.getDefaultToolkit().systemClipboard
            .setContents(java.awt.datatransfer.StringSelection("sentinel"), null)
        onNodeWithText(message, useUnmergedTree = true).performMouseInput {
            moveTo(center)
            press(MouseButton.Primary)
            moveTo(center + Offset(160f, 0f))
            release(MouseButton.Primary)
        }
        waitForIdle()
        pressCtrlC()
        waitForIdle()
        assertNotEquals("sentinel", readClipboard(), "Ctrl+C в ответе ассистента должен заполнить буфер")
    }

    /** Режим выбора сообщений: тап по сообщению переключает выбор, как и раньше. */
    @Test
    fun selectionModeStillTogglesSelection() = runComposeUiTest {
        var toggled = 0
        setContent {
            MaterialTheme {
                UserBubble(
                    item = ChatItem.User(
                        id = "user-1",
                        text = message,
                        files = emptyList(),
                        at = "2026-10-20T12:00:00Z",
                        pending = false,
                        clientId = "desktop",
                        mode = "prompt",
                        turnId = "turn-1",
                    ),
                    time = "12:00",
                    source = null,
                    actions = MessageActions(copy = {}, onToggleSelect = { toggled++ }),
                    onOpenFile = { _, _ -> },
                    loadFile = { Result.failure(IllegalStateException("no files")) },
                    desktop = true,
                )
            }
        }
        waitForIdle()
        onNodeWithText(message, useUnmergedTree = true).performMouseInput {
            moveTo(center)
            press(MouseButton.Primary)
            release(MouseButton.Primary)
        }
        waitForIdle()
        assertEquals(1, toggled, "в режиме выбора тап по сообщению должен переключать выбор")
    }
}
