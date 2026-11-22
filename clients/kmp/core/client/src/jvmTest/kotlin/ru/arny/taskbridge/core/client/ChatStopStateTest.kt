package ru.arny.taskbridge.core.client

import kotlinx.serialization.json.JsonObject
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TaskBridgeJson
import ru.arny.taskbridge.core.api.TaskEvent
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.chat.ChatReducer
import ru.arny.taskbridge.core.client.chat.ToolState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ChatStopStateTest {
    private val task = Task(id = "t", prompt = "question", status = "RUNNING")
    private fun event(seq: Long, type: String, data: String = "{}") = TaskEvent(
        taskId = "t", seq = seq, type = type,
        data = TaskBridgeJson.parseToJsonElement(data) as JsonObject,
    )
    private fun ChatReducer.frame(seq: Long, frame: String) = apply(event(seq, "PI_EVENT", """{"pi":$frame}"""))
    private fun ChatReducer.answer() = snapshot().items.filterIsInstance<ChatItem.Assistant>().last()

    @Test fun cancellationBeforeFirstTokenIsNotFailure() {
        val reducer = ChatReducer(task)
        reducer.frame(1, """{"type":"message_start","message":{"role":"assistant"}}""")
        reducer.frame(2, """{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"aborted","errorMessage":"Request was aborted"}}""")
        reducer.apply(event(3, "TASK_CANCELLED"))
        reducer.syncTask(task.copy(status = "CANCELLED"))
        with(reducer.answer()) {
            assertEquals("CANCELLED", status)
            assertNull(error)
            assertTrue(final)
            assertFalse(active)
        }
    }

    @Test fun cancellationKeepsPartialTextAndInterruptsTools() {
        val reducer = ChatReducer(task)
        reducer.frame(1, """{"type":"tool_execution_start","toolCallId":"b","toolName":"bash"}""")
        reducer.frame(2, """{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"partial"}],"stopReason":"aborted","errorMessage":"Request was aborted"}}""")
        reducer.apply(event(3, "TASK_CANCELLED"))
        with(reducer.answer()) {
            assertEquals("partial", text)
            assertEquals("CANCELLED", status)
            assertNull(error)
            assertEquals(ToolState.INTERRUPTED, tools.single().state)
        }
    }

    @Test fun genuineProviderErrorSurvivesCancellation() {
        val reducer = ChatReducer(task)
        reducer.frame(1, """{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"quota exceeded"}}""")
        reducer.apply(event(2, "TASK_CANCELLED"))
        assertEquals("quota exceeded", reducer.answer().error)
        assertEquals("FAILED", reducer.answer().status)
    }

    @Test fun verificationCannotRestartTypingAfterSettled() {
        val reducer = ChatReducer(task)
        reducer.frame(1, """{"type":"message_start","message":{"role":"assistant"}}""")
        reducer.frame(2, """{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stopReason":"stop"}}""")
        reducer.frame(3, """{"type":"agent_settled"}""")
        reducer.apply(event(4, "STATUS", """{"status":"VERIFYING"}"""))
        assertFalse(reducer.answer().active, "verification is not model streaming")
        reducer.syncTask(task.copy(status = "SUCCEEDED"))
        assertFalse(reducer.answer().active)
    }

    @Test fun pendingEditHidesOldErrorAndRejectionRestoresIt() {
        val reducer = ChatReducer(task)
        reducer.frame(1, """{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"quota exceeded"}}""")
        reducer.apply(event(2, "TASK_FAILED"))
        val before = reducer.answer()
        reducer.setActionStatus("user-initial", "SENDING")
        with(reducer.answer()) {
            assertEquals("SENDING", status)
            assertNull(error)
            assertNull(stopReason)
            assertFalse(final)
            assertFalse(active)
        }
        reducer.setActionStatus("user-initial", null)
        assertEquals(before, reducer.answer())
    }

    @Test fun acceptedEditReplacesTheOldErrorEvenWhenOldCancellationArrivesLate() {
        val reducer = ChatReducer(task, seedInitial = false)
        reducer.apply(event(1, "USER_MESSAGE", """{"text":"old","turn":1}"""))
        reducer.frame(2, """{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"old error"}}""")
        reducer.apply(event(3, "TASK_FAILED", """{"turn":1}"""))
        reducer.setActionStatus("user-1", "SENDING")
        reducer.apply(event(4, "TURN_TRUNCATED", """{"fromSeq":2,"keepUser":true,"reason":"edit"}"""))
        reducer.apply(event(5, "TURN_EDITED", """{"id":"user-1","text":"new","role":"user"}"""))
        reducer.apply(event(6, "TASK_CANCELLED", """{"turn":1}"""))
        assertNull(reducer.answer().error)
        assertTrue(reducer.answer().active)
        assertFalse(reducer.answer().final)
    }

    @Test fun stoppingIsTransientAndDoesNotDestroyThePartialAnswer() {
        val reducer = ChatReducer(task)
        reducer.frame(1, """{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"partial"}],"stopReason":"stop"}}""")
        reducer.setStopping(true)
        assertEquals("STOPPING", reducer.answer().status)
        assertFalse(reducer.answer().active)
        reducer.apply(event(2, "TASK_CANCELLED"))
        reducer.setStopping(false)
        assertEquals("CANCELLED", reducer.answer().status)
        assertEquals("partial", reducer.answer().text)
        assertFalse(reducer.answer().active)
    }

    @Test fun lateTerminalSettlesItsOwnPreviousTurnNotTheNewestOne() {
        val reducer = ChatReducer(task, seedInitial = false)
        reducer.apply(event(1, "USER_MESSAGE", """{"text":"old","turn":1}"""))
        reducer.frame(2, """{"type":"message_start","message":{"role":"assistant"}}""")
        reducer.apply(event(3, "USER_MESSAGE", """{"text":"new","turn":2,"mode":"steer"}"""))
        reducer.apply(event(4, "TASK_CANCELLED", """{"turn":1}"""))
        val answers = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>()
        assertFalse(answers.first().active)
        assertEquals("CANCELLED", answers.first().status)
        assertTrue(answers.last().active)
    }
}
