package ru.arny.taskbridge.ui

import androidx.compose.runtime.saveable.SaverScope
import ru.arny.taskbridge.core.api.ModelRef
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class NavigatorRestoreTest {
    private val saveScope = SaverScope { value ->
        value is String || value is List<*> && value.all { it is String }
    }

    @Test
    fun recreationRestoresTheChatAndProjectBackStack() {
        val navigator = Navigator(Screen.Sessions())
        navigator.push(Screen.Projects)
        navigator.openProject("проект")
        navigator.openProjectSessions("проект")
        navigator.openChat("session-a")
        val saver = Navigator.saver("http://same-server", Screen.Sessions())
        val saved = with(saver) { saveScope.save(navigator) }
        val restored = assertNotNull(saver.restore(assertNotNull(saved)))
        assertEquals(navigator.stack, restored.stack)
        assertTrue(restored.pop())
        assertEquals(Screen.Sessions("проект"), restored.current)
    }

    @Test
    fun draftRecreationPreservesItsCommandIdentityAndModel() {
        val draft = SessionDraft("p", "Проект", ModelRef("provider", "model"), "high", "title", "command-a")
        val navigator = Navigator(Screen.Sessions()).apply { openDraft(draft) }
        val saver = Navigator.saver("server", Screen.Sessions())
        val saved = with(saver) { saveScope.save(navigator) }
        assertEquals(Screen.Draft(draft), assertNotNull(saver.restore(assertNotNull(saved))).current)
    }

    @Test
    fun savedRoutesFromAnotherServerAreNotRestored() {
        val navigator = Navigator(Screen.Sessions()).apply { openChat("foreign-session") }
        val saved = with(Navigator.saver("old-server", Screen.Sessions())) { saveScope.save(navigator) }
        val restored = assertNotNull(Navigator.saver("new-server", Screen.Sessions()).restore(assertNotNull(saved)))
        assertEquals(Screen.Sessions(), restored.current)
        assertFalse(restored.canPop)
    }

    @Test
    fun obsoleteMalformedOrEmptySavedStacksFallBackToTheStartScreen() {
        val saver = Navigator.saver(null, Screen.Connect)
        for (saved in listOf(emptyList(), listOf(""), listOf("", "[]"), listOf("", "invalid"), listOf("", "[{\"type\":\"removed-screen\"}]"))) {
            assertEquals(Screen.Connect, assertNotNull(saver.restore(saved)).current)
        }
    }
}
