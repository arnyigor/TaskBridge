package ru.arny.taskbridge.core.client

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TaskBridgeJson
import ru.arny.taskbridge.core.api.TaskEvent
import ru.arny.taskbridge.core.client.chat.AnswerUsage
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.chat.ChatReducer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Токены ответа: Pi присылает `usage` в каждом `message_end`, а один ответ — это
 * несколько вызовов модели (между ними инструменты). Считаем сумму по ответу:
 * `input` — вход без кэша, `cacheRead` — попадания в кэш, `output` — вывод.
 */
class MessageUsageTest {
    private val task = Task(id = "usage", status = "RUNNING", prompt = "Question")

    private fun events(vararg frames: String) = frames.mapIndexed { index, frame ->
        TaskEvent(taskId = task.id, seq = index + 1L, type = "PI_EVENT", data = buildJsonObject { put("pi", TaskBridgeJson.parseToJsonElement(frame)) })
    }

    private fun answer(reducer: ChatReducer) = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>().single()

    @Test
    fun `токены складываются по всем вызовам модели внутри ответа`() {
        val log = events(
            """{"type":"message_start","message":{"role":"assistant"}}""",
            """{"type":"message_end","message":{"role":"assistant","model":"deepseek-flash","content":[{"type":"text","text":"сначала "}],"usage":{"input":250,"output":96,"cacheRead":14592,"totalTokens":14938,"cost":{"total":0}}}}""",
            """{"type":"tool_execution_start","toolName":"read","toolCallId":"a"}""",
            """{"type":"tool_execution_end","toolCallId":"a"}""",
            """{"type":"message_start","message":{"role":"assistant"}}""",
            """{"type":"message_end","message":{"role":"assistant","model":"deepseek-flash","content":[{"type":"text","text":"потом"}],"usage":{"input":100,"output":10,"cacheRead":1000,"totalTokens":1110,"cost":{"total":0}}}}""",
        )
        val reducer = ChatReducer(task)
        log.forEach { reducer.apply(it) }

        val item = answer(reducer)
        assertEquals(AnswerUsage(hit = 15_592, miss = 350, out = 106), item.usage)
        assertEquals(15_592 + 350 + 106, item.usage?.total)
        // Модель приходит в самом кадре: после смены модели в сессии старый ответ
        // не должен пересчитываться по новой цене.
        assertEquals("deepseek-flash", item.usageModel)
    }

    @Test
    fun `повтор того же события не удваивает расход`() {
        val log = events(
            """{"type":"message_start","message":{"role":"assistant"}}""",
            """{"type":"message_end","message":{"role":"assistant","model":"deepseek-flash","content":[{"type":"text","text":"ответ"}],"usage":{"input":10,"output":5,"cacheRead":100}}}""",
        )
        val reducer = ChatReducer(task)
        (log + log).forEach { reducer.apply(it) }
        assertEquals(AnswerUsage(hit = 100, miss = 10, out = 5), answer(reducer).usage)
    }

    @Test
    fun `пустой usage прерванного вызова не считается расходом`() {
        val log = events(
            """{"type":"message_start","message":{"role":"assistant"}}""",
            """{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":""}],"stopReason":"aborted","usage":{"input":0,"output":0,"cacheRead":0,"totalTokens":0}}}""",
        )
        val reducer = ChatReducer(task)
        log.forEach { reducer.apply(it) }
        assertNull(answer(reducer).usage)
    }
}
