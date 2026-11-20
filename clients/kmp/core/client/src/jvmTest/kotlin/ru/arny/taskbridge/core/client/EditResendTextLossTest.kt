package ru.arny.taskbridge.core.client

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TaskBridgeJson
import ru.arny.taskbridge.core.api.TaskEvent
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.chat.ChatReducer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * RED-тест BUG-P0 (журнал b2451ed63c8b, 2026-11-20): после Edit→Resend ход
 * закрылся как SUCCEEDED, но текст ответа (2908 символов из PI-кадров) не
 * попал в заглушку — в чате остался пустой «Ответ не был получен».
 * Реплей реальных кадров: TURN_TRUNCATED → TURN_EDITED → PI message_start/end
 * с текстом → agent_settled → TASK_SUCCEEDED.
 */
class EditResendTextLossTest {

    private fun loadEvents(): List<TaskEvent> {
        val stream = this::class.java.getResourceAsStream("/edit-resend-pi-frames.jsonl")!!
        return stream.bufferedReader().readLines().filter { it.isNotBlank() }.map { line ->
            val e = TaskBridgeJson.parseToJsonElement(line) as JsonObject
            TaskEvent(
                taskId = "b2451ed63c8b",
                seq = e["seq"]!!.jsonPrimitive.long,
                type = e["type"]!!.jsonPrimitive.content,
                at = e["at"]?.jsonPrimitive?.content ?: "",
                data = e["data"] as? JsonObject ?: JsonObject(emptyMap()),
            )
        }
    }

    private fun reducer() = ChatReducer(Task(id = "b2451ed63c8b", prompt = "диалог", status = "RUNNING"))

    private fun assistants(reducer: ChatReducer) =
        reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>()

    @Test
    fun `the resent answer text from pi frames reaches the fresh placeholder`() {
        val reducer = reducer()
        for (event in loadEvents()) {
            reducer.apply(event)
            val items = assistants(reducer)
            val cur = items.lastOrNull()
            if (event.type == "PI_EVENT") {
                val pi = (event.data as? kotlinx.serialization.json.JsonObject)?.get("pi") as? kotlinx.serialization.json.JsonObject
                val pt = pi?.get("type")?.jsonPrimitive?.content
                if (pt in listOf("message_start","message_end","agent_start","turn_start")) {
                    println("DBG seq=" + event.seq + " PI:" + pt + " role=" + ((pi?.get("message") as? kotlinx.serialization.json.JsonObject)?.get("role")?.jsonPrimitive?.content ?: "-") +
                        " -> last text=" + cur?.text?.length + " id=" + cur?.id + " active=" + cur?.active)
                    continue
                }
            }
            println("DBG seq=" + event.seq + " " + event.type + " -> assistants=" + items.size + " last: text=" + cur?.text?.length + " active=" + cur?.active + " id=" + cur?.id)
        }
        // Ответ после правки: ход, открытый по TURN_EDITED (assistant-36571),
        // обязан получить полный текст ответа (2908 симв. из PI-кадров) и
        // закрыться успешно — без «Ответ не был получен».
        val answer = assistants(reducer).first { it.id == "assistant-36571" }
        assertTrue(answer.text.length >= 2000, "текст ответа из PI-кадров попал в заглушку (${answer.text.length} симв.)")
        assertEquals("SUCCEEDED", answer.status)
        assertEquals(null, answer.error)
        // Пустых FAILED-заглушек нет.
        assertTrue(
            assistants(reducer).none { it.final && it.error != null && it.text.isBlank() },
            "пустой FAILED-блок не появляется",
        )
    }
}
