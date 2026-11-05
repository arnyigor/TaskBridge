package ru.arny.taskbridge.ui

import androidx.compose.runtime.saveable.SaverScope
import kotlin.test.*

class RemoteFilesNavigationTest {
    @Test
    fun remoteRouteRestoresOnlyProjectChatAndVirtualLocation() {
        val navigator = Navigator(Screen.Sessions("p"))
        navigator.openChat("chat")
        navigator.push(Screen.RemoteFiles("p", "chat"))
        navigator.remoteLocation("downloads", "images/reference")
        val saver = Navigator.saver("pc", Screen.Sessions())
        val saved = assertNotNull(with(saver) { SaverScope { true }.save(navigator) })
        val restored = assertNotNull(saver.restore(saved))
        assertEquals(Screen.RemoteFiles("p", "chat", "downloads", "images/reference"), restored.current)
        assertTrue(restored.pop())
        assertEquals(Screen.Chat("chat"), restored.current)
        assertFalse(saved.joinToString().contains("base64"))
        assertFalse(saved.joinToString().contains("uploadToken"))
    }

    @Test
    fun openingAnotherChatDoesNotLeaveAForeignFilePickerInItsBackStack() {
        val navigator = Navigator(Screen.Sessions())
        navigator.openChat("old")
        navigator.push(Screen.RemoteFiles("old-project", "old", "root", "folder"))
        navigator.openChat("new")
        assertEquals(Screen.Chat("new"), navigator.current)
        assertFalse(navigator.stack.any { it is Screen.RemoteFiles })
    }
}
