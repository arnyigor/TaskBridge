package ru.arny.taskbridge.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class NavigatorProjectTest {
    @Test
    fun projectSessionsRemainBelowTheProjectDashboardOnTheBackStack() {
        val navigator = Navigator(Screen.Sessions())
        navigator.push(Screen.Projects)
        navigator.openProject("taskbridge")
        navigator.openProjectSessions("taskbridge")

        assertEquals(Screen.Sessions("taskbridge"), navigator.current)
        navigator.openChat("session-a")
        assertEquals(Screen.Chat("session-a"), navigator.current)
        assertEquals(
            Screen.Sessions("taskbridge"),
            navigator.stack.last { it is Screen.Sessions },
            "the wide session pane keeps its project filter while a chat is current",
        )
        assertTrue(navigator.pop())
        assertEquals(Screen.Sessions("taskbridge"), navigator.current)
        assertTrue(navigator.pop())
        assertEquals(Screen.Project("taskbridge"), navigator.current)
        assertTrue(navigator.pop())
        assertEquals(Screen.Projects, navigator.current)
    }
}
