package ru.arny.taskbridge.core.client

import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TaskBridgeJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** Additive turn-state fields must remain compatible with old server snapshots. */
class TurnStateCompatTest {
    @Test
    fun `an old task without turn state keeps the compatibility defaults`() {
        val task = TaskBridgeJson.decodeFromString<Task>(
            """{"id":"old","status":"RUNNING"}""",
        )

        assertNull(task.turnState)
        assertEquals(0L, task.snapshotSeq)
    }

    @Test
    fun `a new task decodes the progress point`() {
        val task = TaskBridgeJson.decodeFromString<Task>(
            """{"id":"new","status":"RUNNING","snapshotSeq":42,"turnState":{"phase":"PROGRESS","turn":3,"stage":"tool","lastProgressAt":"2026-10-14T00:00:00Z","silentMs":1200}}""",
        )

        assertEquals(42L, task.snapshotSeq)
        assertEquals("PROGRESS", task.turnState?.phase)
        assertEquals(3L, task.turnState?.turn)
        assertEquals("tool", task.turnState?.stage)
        assertEquals(1200L, task.turnState?.silentMs)
    }
}
