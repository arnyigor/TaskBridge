package ru.arny.taskbridge.core.client

import ru.arny.taskbridge.core.api.Project
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.client.sessions.DisplayState
import ru.arny.taskbridge.core.client.sessions.SessionAlert
import ru.arny.taskbridge.core.client.sessions.SessionAlerts
import ru.arny.taskbridge.core.client.sessions.SessionListState
import ru.arny.taskbridge.core.client.sessions.displayStateOf
import ru.arny.taskbridge.core.client.settings.normalizeServerUrl
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SessionStateTest {
    private fun task(id: String, status: String, updated: String = "2026-09-24T10:00:00.000Z", errorCode: String? = null, project: String? = "p") =
        Task(id = id, status = status, updatedAt = updated, errorCode = errorCode, prompt = "задача $id", projectId = project)

    @Test
    fun displayStates() {
        assertEquals(DisplayState.RESTORABLE, displayStateOf(task("a", "FAILED", errorCode = "FAILED_RECOVERY")))
        assertEquals(DisplayState.RESTORABLE, displayStateOf(task("a", "FAILED", errorCode = "PI_SESSION_FAILED")))
        assertEquals(DisplayState.FAILED, displayStateOf(task("a", "FAILED", errorCode = "MODEL_ERROR")))
        assertEquals(DisplayState.WORKING, displayStateOf(task("a", "CANCELLING")))
        assertEquals(DisplayState.UNKNOWN, displayStateOf(task("a", "HIBERNATED")))
    }

    @Test
    fun waitingFirstThenWorkingThenRecent() {
        val state = SessionListState(
            tasks = listOf(
                task("old", "SUCCEEDED", "2026-09-24T09:00:00.000Z"),
                task("new", "SUCCEEDED", "2026-09-24T11:00:00.000Z"),
                task("work", "RUNNING", "2026-09-24T08:00:00.000Z"),
                task("wait", "WAITING_USER", "2026-09-24T07:00:00.000Z", project = null),
            ),
            projects = listOf(Project("p", "Проект")),
        )
        assertEquals(listOf("wait", "work", "new", "old"), state.sorted.map { it.id })
        val groups = state.groups()
        assertEquals(listOf("Без проекта", "Проект"), groups.map { it.title })
        assertEquals(listOf("work", "new", "old"), groups[1].sessions.map { it.id })
        assertEquals(listOf("new"), state.groups("задача new").flatMap { it.sessions }.map { it.id })
        assertEquals(1, state.waitingCount)
        assertEquals(1, state.workingCount)
    }

    @Test
    fun alertsOnlyOnTransitions() {
        val alerts = SessionAlerts()
        assertTrue(alerts.update(listOf(task("a", "RUNNING"), task("b", "SUCCEEDED"))).isEmpty(), "the first list is a baseline")
        assertTrue(alerts.update(listOf(task("a", "RUNNING"), task("b", "SUCCEEDED"))).isEmpty())
        val waiting = alerts.update(listOf(task("a", "WAITING_USER"), task("b", "SUCCEEDED")))
        assertEquals(listOf(SessionAlert.Kind.WAITING_USER), waiting.map { it.kind })
        val done = alerts.update(listOf(task("a", "SUCCEEDED"), task("b", "SUCCEEDED"), task("c", "RUNNING")))
        assertEquals(listOf(SessionAlert.Kind.FINISHED), done.map { it.kind })
        val failed = alerts.update(listOf(task("a", "SUCCEEDED"), task("c", "FAILED", errorCode = "PI_SESSION_FAILED")))
        assertEquals(listOf("c" to SessionAlert.Kind.FAILED), failed.map { it.taskId to it.kind })
    }

    @Test
    fun serverAddresses() {
        assertEquals("http://192.168.1.5:8787", normalizeServerUrl("192.168.1.5"))
        assertEquals("http://192.168.1.5:9000", normalizeServerUrl(" 192.168.1.5:9000/ "))
        assertEquals("https://pc.local:8443", normalizeServerUrl("https://pc.local:8443/"))
        assertEquals("https://pc.example", normalizeServerUrl("https://pc.example"))
        assertNull(normalizeServerUrl("ftp://x"))
        assertNull(normalizeServerUrl("host:99999"))
        assertNull(normalizeServerUrl("   "))
    }
}
