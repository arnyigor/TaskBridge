package ru.arny.taskbridge.core.client

import kotlinx.serialization.json.JsonObject
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TurnState
import ru.arny.taskbridge.core.api.TaskEvent
import ru.arny.taskbridge.core.api.TaskBridgeJson
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.chat.ChatReducer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.assertFalse

/**
 * Жизненный цикл правки (BUG-P0): терминал чужого поколения не имеет права
 * закрывать новый ход после TURN_TRUNCATED. Все последовательности — реальные
 * формы событий сервера (USER_MESSAGE несёт data.turn, терминалы — тоже).
 */
class EditLifecycleTest {
    private val task = Task(id = "t", prompt = "question", status = "RUNNING")

    private fun event(seq: Long, type: String, at: String, data: JsonObject): TaskEvent =
        TaskEvent(taskId = "t", seq = seq, type = type, at = at, data = data)

    private fun userMessage(seq: Long, at: String, text: String, turn: Long): TaskEvent =
        event(seq, "USER_MESSAGE", at, TaskBridgeJson.parseToJsonElement(
            """{"text": "$text", "message": "$text", "turn": $turn}""") as JsonObject)

    private fun terminal(type: String, seq: Long, at: String, turn: Long?, message: String? = null): TaskEvent =
        event(seq, type, at, TaskBridgeJson.parseToJsonElement(
            """{"turn": ${turn ?: "null"}}""") as JsonObject).let { if (message == null) it else it.copy(message = message) }

    private fun turnTruncated(seq: Long, at: String, fromSeq: Long): TaskEvent =
        event(seq, "TURN_TRUNCATED", at, TaskBridgeJson.parseToJsonElement(
            """{"fromSeq": $fromSeq, "keepUser": true, "reason": "edit"}""") as JsonObject)

    private fun reducer() = ChatReducer(task)

    private fun assistants(reducer: ChatReducer) = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>()
    private fun lastUser(reducer: ChatReducer) = reducer.snapshot().items.filterIsInstance<ChatItem.User>().last()

    @Test
    fun `an old CANCELLED arriving after the edit cannot fail the fresh placeholder`() {
        val reducer = reducer()
        // Ход N доставлен и прерван STOP-ом; правка обрезала историю, заглушка без номера.
        reducer.apply(userMessage(100, "12:00:00", "вопрос", 5))
        reducer.apply(terminal("TASK_CANCELLED", 110, "12:00:20", 5))
        reducer.apply(turnTruncated(120, "12:00:30", fromSeq = 101))
        val placeholder = assistants(reducer).last()
        assertTrue(placeholder.active, "заглушка ждёт повторную доставку")

        // Поздний терминал прежнего поколения — ПОСЛЕ правки (по seq и по at).
        reducer.apply(terminal("TASK_CANCELLED", 130, "12:00:40", 5))
        assertFalse(placeholder.final, "чужой терминал не закрывает новый ход")
        assertEquals(null, placeholder.error)
        assertTrue(assistants(reducer).last().active)
    }

    @Test
    fun `snapshot SUCCEEDED of another generation cannot close the placeholder`() {
        val reducer = reducer()
        reducer.apply(userMessage(100, "12:00:00", "вопрос", 5))
        reducer.apply(turnTruncated(120, "12:00:30", fromSeq = 101))
        // syncTask со старым снимком: статус SUCCEEDED, снимок знает старый номер N.
        reducer.syncTask(task.copy(status = "SUCCEEDED", turnState = TurnState(phase = "SETTLED", turn = 5)))
        val placeholder = assistants(reducer).last()
        assertFalse(placeholder.final, "снимок чужого поколения не закрывает заглушку")
        assertTrue(placeholder.active)
    }

    @Test
    fun `a real FAILED of the new turn keeps the true error and the red row`() {
        val reducer = reducer()
        reducer.apply(userMessage(100, "12:00:00", "вопрос", 5))
        reducer.apply(turnTruncated(120, "12:00:30", fromSeq = 101))
        // Повторная доставка нумерует ход: N+1 приходит со снимком статуса.
        reducer.syncTask(task.copy(status = "RUNNING", turnState = TurnState(phase = "PROGRESS", turn = 6)))
        reducer.apply(terminal("TASK_FAILED", 140, "12:01:10", 6, message = "Provider returned error: 500"))
        val failed = assistants(reducer).last()
        assertTrue(failed.final, "свой терминал закрывает ход")
        assertTrue(failed.error != null, "настоящая ошибка сохраняется")
        assertEquals("FAILED", failed.status)
    }

    @Test
    fun `a successful resent answer leaves no empty FAILED block`() {
        val reducer = reducer()
        reducer.apply(userMessage(100, "12:00:00", "вопрос", 5))
        reducer.apply(turnTruncated(120, "12:00:30", fromSeq = 101))
        reducer.syncTask(task.copy(status = "RUNNING", turnState = TurnState(phase = "PROGRESS", turn = 6)))
        // Новый ход ответил успешно: терминал своего поколения.
        reducer.apply(terminal("TASK_SUCCEEDED", 150, "12:02:00", 6))
        val done = assistants(reducer).last()
        assertFalse(done.active)
        assertEquals("SUCCEEDED", done.status)
        assertEquals(null, done.error)
        assertTrue(lastUser(reducer).delivery != "Ошибка ответа", "успех не помечается ошибкой")
    }
}
