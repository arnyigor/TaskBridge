package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertEquals
import ru.arny.taskbridge.core.api.PlanContent
import ru.arny.taskbridge.core.api.PlanStatus

class PlanEditorContractTest {
    @Test
    fun `SSE refresh does not replace the draft or its original CAS base`() {
        val state = FollowPlanUiState("session-a")
        val base = PlanContent("docs/PLAN.md", 3, "hash-3", "original Markdown")
        state.editorBase = base
        state.editorText = "unsaved Markdown"
        state.status = PlanStatus(attached = true, revision = 4, hash = "hash-4")
        assertEquals(base, state.editorBase)
        assertEquals("unsaved Markdown", state.editorText)
        assertEquals(3, state.editorBase?.revision)
    }

    @Test
    fun `editor state is scoped to a session and not a device file path`() {
        val first = FollowPlanUiState("session-a")
        val second = FollowPlanUiState("session-b")
        first.editorBase = PlanContent("PLAN.md", 1, "hash-1", "server file")
        first.editorText = "draft"
        assertEquals(null, second.editorBase)
        assertEquals("", second.editorText)
    }
}
