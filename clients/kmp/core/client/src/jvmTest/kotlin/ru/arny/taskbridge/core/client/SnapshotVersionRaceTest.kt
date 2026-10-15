package ru.arny.taskbridge.core.client

import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TurnState
import ru.arny.taskbridge.core.api.mergeTaskSnapshot
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Шаг C-B: гонка «GET метаданных vs SSE». Снимок версионирован snapshotSeq (seq
 * последнего события); ответ, прочитанный до более свежего события, не откатывает
 * «лицо» хода.
 */
class SnapshotVersionRaceTest {
    private val live = Task(
        id = "t", status = "RUNNING", current = "модель отвечает", snapshotSeq = 12, workspacePath = "G:\\p",
        turnState = TurnState(phase = "PROGRESS", turn = 2), runtime = null,
    )

    @Test
    fun `an older snapshot cannot roll the turn face back`() {
        val older = Task(
            id = "t", status = "RUNNING", current = "Pi starting", snapshotSeq = 5, workspacePath = "G:\\p",
            turnState = TurnState(phase = "DISPATCHING", turn = 2),
        )
        // Клиент уже применил события до 12-го: значит ответ с версией 5 устарел.
        val merged = mergeTaskSnapshot(live, older, appliedCursor = 12)
        assertEquals("PROGRESS", merged.turnState?.phase)
        assertEquals("модель отвечает", merged.current)
        assertEquals(12L, merged.snapshotSeq, "старшинство остаётся по максимуму")
    }

    @Test
    fun `a fresh snapshot is applied as a whole`() {
        val fresh = Task(id = "t", status = "SUCCEEDED", current = "Done", snapshotSeq = 20)
        val merged = mergeTaskSnapshot(live, fresh, appliedCursor = 12)
        assertEquals("SUCCEEDED", merged.status)
        assertEquals("Done", merged.current)
        assertEquals(20L, merged.snapshotSeq)
    }

    @Test
    fun `a server without versions keeps the old behaviour`() {
        val unversioned = Task(id = "t", status = "RUNNING", current = "старый сервер", snapshotSeq = 0)
        assertEquals("старый сервер", mergeTaskSnapshot(live, unversioned, appliedCursor = 12).current)
        assertEquals("старт", mergeTaskSnapshot(null, Task(id = "t", current = "старт"), appliedCursor = 3).current)
    }
}
