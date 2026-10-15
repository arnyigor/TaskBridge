package ru.arny.taskbridge.core.client

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TaskEvent
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.chat.ChatReducer
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Этап M2: факт инъекции памяти показывается в ленте чата — оператор видит, что
 * память сработала, а не догадывается по поведению модели. Числа (заметки, токены)
 * лежат рядом с ходом, к которому относились.
 */
class MemoryInjectedNoteTest {
    private fun injection(seq: Long, notes: Int, tokens: Int) = TaskEvent(
        taskId = "t", seq = seq, type = "MEMORY_INJECTED",
        message = "Память: $notes заметок (~$tokens токенов)",
        data = buildJsonObject { put("notes", notes); put("tokens", tokens) },
    )

    @Test
    fun `an injection becomes one note in the transcript`() {
        val reducer = ChatReducer(Task(id = "t", status = "RUNNING"))
        reducer.apply(injection(3, notes = 4, tokens = 820))
        val notes = reducer.snapshot().items.filterIsInstance<ChatItem.Note>()
        assertEquals(1, notes.size, notes.map { it.text }.toString())
        assertEquals("Память: 4 заметок (~820 токенов)", notes.single().text)
        // Повтор того же события (догон после переподключения) не удваивает заметку.
        reducer.apply(injection(3, notes = 4, tokens = 820))
        assertEquals(1, reducer.snapshot().items.filterIsInstance<ChatItem.Note>().size)
    }

    @Test
    fun `an injection does not create an answer of its own`() {
        val withEvent = ChatReducer(Task(id = "t", status = "RUNNING"))
        val without = ChatReducer(Task(id = "t", status = "RUNNING"))
        withEvent.apply(injection(3, notes = 1, tokens = 40))
        fun answers(reducer: ChatReducer) = reducer.snapshot().items.count { it is ChatItem.Assistant }
        assertEquals(answers(without), answers(withEvent), "инъекция не добавляет ответ")
    }
}
