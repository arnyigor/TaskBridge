package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.unit.dp
import kotlin.test.*

/**
 * Ctrl+Enter в окне правки сообщения должен отправлять текст, обычный Enter — переводить строку.
 * Проверяется через `TextEditDialog`: это тот самый диалог «Изменить сообщение»/«Исправить ответ».
 */
@OptIn(ExperimentalTestApi::class)
class TextEditDialogSubmitTest {

    private fun ComposeUiTest.showDialog(initial: String, onConfirm: (String) -> Unit, onDismiss: () -> Unit = {}) {
        setContent {
            MaterialTheme {
                Box(Modifier.size(640.dp, 720.dp)) {
                    TextEditDialog(
                        title = "Изменить сообщение",
                        hint = null,
                        initial = initial,
                        confirm = "Отправить заново",
                        onConfirm = onConfirm,
                        onDismiss = onDismiss,
                    )
                }
            }
        }
    }

    @Test
    fun ctrlEnterSendsTheEditedText() = runComposeUiTest {
        val sent = mutableListOf<String>()
        showDialog("исправленный текст", onConfirm = { sent += it })
        val field = onNode(hasSetTextAction())
        field.performSemanticsAction(SemanticsActions.RequestFocus)
        field.performKeyInput { withKeyDown(Key.CtrlLeft) { pressKey(Key.Enter) } }
        assertEquals(listOf("исправленный текст"), sent)
    }

    @Test
    fun metaEnterSendsToo() = runComposeUiTest {
        val sent = mutableListOf<String>()
        showDialog("текст", onConfirm = { sent += it })
        val field = onNode(hasSetTextAction())
        field.performSemanticsAction(SemanticsActions.RequestFocus)
        field.performKeyInput { withKeyDown(Key.MetaLeft) { pressKey(Key.Enter) } }
        assertEquals(listOf("текст"), sent)
    }

    @Test
    fun repeatedKeyDownSendsOnlyOnce() = runComposeUiTest {
        val sent = mutableListOf<String>()
        showDialog("текст", onConfirm = { sent += it })
        val field = onNode(hasSetTextAction())
        field.performSemanticsAction(SemanticsActions.RequestFocus)
        field.performKeyInput {
            withKeyDown(Key.CtrlLeft) {
                pressKey(Key.Enter)
                pressKey(Key.Enter)
                pressKey(Key.Enter)
            }
        }
        assertEquals(listOf("текст"), sent)
    }

    @Test
    fun blankTextIsNotSent() = runComposeUiTest {
        val sent = mutableListOf<String>()
        showDialog("   ", onConfirm = { sent += it })
        val field = onNode(hasSetTextAction())
        field.performSemanticsAction(SemanticsActions.RequestFocus)
        field.performKeyInput { withKeyDown(Key.CtrlLeft) { pressKey(Key.Enter) } }
        assertTrue(sent.isEmpty())
    }

    @Test
    fun plainEnterDoesNotSend() = runComposeUiTest {
        val sent = mutableListOf<String>()
        showDialog("текст", onConfirm = { sent += it })
        val field = onNode(hasSetTextAction())
        field.performSemanticsAction(SemanticsActions.RequestFocus)
        field.performKeyInput { pressKey(Key.Enter) }
        assertTrue(sent.isEmpty())
    }
}
