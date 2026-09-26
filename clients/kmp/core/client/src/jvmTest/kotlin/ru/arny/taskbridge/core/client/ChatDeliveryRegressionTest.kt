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
import kotlin.test.assertTrue

class ChatDeliveryRegressionTest {
    private val task = Task(id = "t", prompt = "question", status = "RUNNING")
    private fun event(seq: Long, type: String, data: String) = TaskEvent(
        taskId = "t", seq = seq, type = type,
        data = TaskBridgeJson.parseToJsonElement(data) as JsonObject,
    )
    private fun ChatReducer.frame(seq: Long, frame: String) = apply(event(seq, "PI_EVENT", """{"pi":$frame}"""))

    @Test fun initialPromptShowsActualHandoffAndKeepsLaterProgress() {
        val reducer = ChatReducer(task.copy(status = "QUEUED"))
        assertEquals("В очереди на сервере", (reducer.snapshot().items.first() as ChatItem.User).delivery)
        reducer.syncTask(task.copy(status = "RUNNING"))
        assertEquals("Ожидает подтверждения Pi", (reducer.snapshot().items.first() as ChatItem.User).delivery)
        reducer.apply(event(1, "PROMPT_ACCEPTED", """{"initial":true}"""))
        assertEquals("Принято Pi · ждём ответ модели", (reducer.snapshot().items.first() as ChatItem.User).delivery)
        reducer.frame(2, """{"type":"message_start","message":{"role":"assistant"}}""")
        reducer.apply(event(3, "PROMPT_ACCEPTED", """{"initial":true}"""))
        reducer.syncTask(task.copy(status = "SUCCEEDED"))
        assertEquals("Модель начала ответ", (reducer.snapshot().items.first() as ChatItem.User).delivery)
    }

    @Test fun deletingAnswerKeepsQuestionOnLiveAndReplay() {
        val events = listOf(
            event(1, "USER_MESSAGE", """{"text":"keep"}"""),
            event(2, "TASK_SUCCEEDED", "{}"),
            event(3, "USER_MESSAGE", """{"text":"remove"}"""),
            event(4, "TURN_TRUNCATED", """{"fromSeq":2,"keepUser":true,"reason":"delete"}"""),
        )
        val live = ChatReducer(task)
        events.forEach(live::apply)
        val replay = ChatReducer(task)
        listOf(events[0], events[3]).forEach(replay::apply)
        assertEquals(live.snapshot().items.map { it.id }, replay.snapshot().items.map { it.id })
        assertEquals("user-1", live.snapshot().items.last().id)
        assertEquals("keep", (live.snapshot().items.last() as ChatItem.User).text)
    }

    @Test fun deletingInitialAnswerDoesNotLeaveTypingPlaceholder() {
        val reducer = ChatReducer(task)
        reducer.apply(event(3, "TURN_TRUNCATED", """{"fromSeq":1,"keepUser":true,"reason":"delete"}"""))
        reducer.syncTask(task.copy(status = "SUCCEEDED"))
        assertEquals(listOf("user-initial"), reducer.snapshot().items.map { it.id })
    }

    @Test fun steeringWaitsForToolsAndClosesPreviousBubbleAtNextAnswer() {
        val reducer = ChatReducer(task)
        reducer.frame(1, """{"type":"message_start","message":{"role":"assistant"}}""")
        reducer.frame(2, """{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"toolUse"}}""")
        reducer.frame(3, """{"type":"tool_execution_start","toolCallId":"tool","toolName":"bash"}""")
        reducer.apply(event(4, "USER_MESSAGE", """{"text":"change direction","mode":"steer"}"""))
        var previous = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>().first()
        assertTrue(previous.active)
        assertEquals(ToolState.RUNNING, previous.tools.single().state)
        reducer.frame(5, """{"type":"tool_execution_end","toolCallId":"tool","toolName":"bash"}""")
        reducer.frame(6, """{"type":"message_start","message":{"role":"assistant"}}""")
        previous = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>().first()
        assertFalse(previous.active)
        assertTrue(previous.final)
        assertEquals(ToolState.DONE, previous.tools.single().state)
        assertTrue(reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>().last().active)
    }

    @Test fun oldTerminalTaskCannotFinishAnUnacknowledgedMessage() {
        val reducer = ChatReducer(task.copy(status = "SUCCEEDED"))
        reducer.addOptimistic("cmd", "new")
        reducer.syncTask(task.copy(status = "SUCCEEDED"))
        val pending = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>().last()
        assertTrue(pending.active)
        assertFalse(pending.final)
        reducer.acknowledge("cmd")
        assertTrue(reducer.snapshot().items.filterIsInstance<ChatItem.User>().last().delivery.startsWith("Принято сервером"))
    }

    @Test fun errorMessageEndsAnimationEvenWithoutSettledFrame() {
        val reducer = ChatReducer(task)
        reducer.frame(1, """{"type":"message_start","message":{"role":"assistant"}}""")
        reducer.frame(2, """{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"provider failed","content":[]}}""")
        val answer = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>().single()
        assertFalse(answer.active)
        assertTrue(answer.final)
        assertEquals("FAILED", answer.status)
    }

    @Test fun severalSteersKeepEachPiAnswerWithItsOwnQuestion() {
        val reducer = ChatReducer(task, seedInitial = false)
        reducer.apply(event(1, "USER_MESSAGE", """{"text":"1","mode":"prompt"}"""))
        reducer.frame(2, """{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"1"}]}}""")
        reducer.apply(event(3, "USER_MESSAGE", """{"text":"2","mode":"steer"}"""))
        reducer.apply(event(4, "USER_MESSAGE", """{"text":"3","mode":"steer"}"""))
        for ((start, question, answer) in listOf(Triple(5L, "1", "Первый"), Triple(9L, "2", "Второй"), Triple(13L, "3", "Третий"))) {
            if (start > 5) reducer.frame(start - 1, """{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"$question"}]}}""")
            reducer.frame(start, """{"type":"message_start","message":{"role":"assistant"}}""")
            reducer.frame(start + 1, """{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"$answer"}],"stopReason":"stop"}}""")
            reducer.frame(start + 2, """{"type":"turn_end"}""")
        }
        reducer.apply(event(16, "TASK_SUCCEEDED", "{}"))
        val users = reducer.snapshot().items.filterIsInstance<ChatItem.User>()
        val answers = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>()
        assertEquals(listOf("1", "2", "3"), users.map { it.text })
        assertEquals(listOf("Первый", "Второй", "Третий"), answers.map { it.text })
        assertEquals(listOf("Ответ получен", "Ответ получен", "Ответ получен"), users.map { it.delivery })
        assertTrue(answers.all { it.final && !it.active })
    }

    @Test fun piUserFrameDoesNotReplaceARegeneratedVariant() {
        val reducer = ChatReducer(task, seedInitial = false)
        reducer.apply(event(1, "USER_MESSAGE", """{"text":"again","mode":"prompt"}"""))
        reducer.apply(event(2, "TURN_VARIANT_START", """{"turnSeq":1,"variantId":"new"}"""))
        reducer.frame(3, """{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"again"}]}}""")
        reducer.frame(4, """{"type":"message_start","message":{"role":"assistant"}}""")
        reducer.frame(5, """{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"New answer"}],"stopReason":"stop"}}""")
        val visible = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>()
        assertEquals(listOf("assistant-new"), visible.map { it.id })
        assertEquals("New answer", visible.single().text)
    }
}
