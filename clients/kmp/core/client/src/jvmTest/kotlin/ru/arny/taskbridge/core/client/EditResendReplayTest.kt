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
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Реплей реального журнала сервера (2026-11-19, task b2451ed63c8b, seq 12914–12965):
 * отправка → прерывание (PI-событий не было, ход оборван в DISPATCHING) → правка
 * (TURN_TRUNCATED + TURN_EDITED, keepUser) → повторная отправка, ход продолжается.
 *
 * Требования BUG-01/02: после реплея ровно одно сообщение оператора, нет пустых
 * FAILED-пузырей от оборванного хода, ответ идёт активным ходом.
 */
class EditResendReplayTest {
    private val task = Task(id = "b2451ed63c8b", prompt = "question", status = "RUNNING")

    private fun loadEvents(): List<TaskEvent> {
        val stream = this::class.java.getResourceAsStream("/edit-after-stop-replay.jsonl")!!
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

    @Test
    fun `stop and edit cannot leave a phantom failed bubble`() {
        val reducer = ChatReducer(task)
        for (e in loadEvents()) reducer.apply(e)
        val users = reducer.snapshot().items.filterIsInstance<ChatItem.User>()
        val assistants = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>()
        // В чате есть старая история (user-initial) — важно, что правленное сообщение
        // единственное и обновлено по месту (TURN_EDITED), без дубликата.
        assertEquals(1, users.count { it.id != "user-initial" })
        assertEquals("Я отправил,затем остановил, отредактировал и снова отправил", users.last().text)
        // Оборванный ход не оставляет пустого FAILED-пузыря.
        val failedEmpty = assistants.filter { it.final && it.error != null && it.text.isBlank() }
        assertTrue(failedEmpty.isEmpty(), "phantom failed empty bubbles: $failedEmpty")
        // Ход после повторной отправки активен.
        val active = assistants.last()
        assertTrue(active.active, "the resent turn must be streaming")
        assertFalse(active.final)
    }
}
