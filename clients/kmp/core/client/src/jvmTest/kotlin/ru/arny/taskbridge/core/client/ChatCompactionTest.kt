package ru.arny.taskbridge.core.client

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TaskBridgeJson
import ru.arny.taskbridge.core.api.TaskEvent
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.chat.ChatReducer
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ChatCompactionTest {
    @Serializable
    data class Fixture(val task: Task, val events: List<TaskEvent>)

    private fun fixture(name: String): Fixture {
        val dir = File(System.getProperty("taskbridge.chatFixtures")).parentFile.resolve("compaction")
        return TaskBridgeJson.decodeFromString(Fixture.serializer(), dir.resolve("pi-1.4.0-$name.json").readText())
    }

    @Serializable
    data class ExpectedItem(val id: String, val role: String, val text: String, val tools: List<String>)

    @Test
    fun bothFixturesMatchTheSameGoldenAsWeb() {
        for (name in listOf("auto", "manual")) {
            val f = fixture(name)
            val reducer = ChatReducer(f.task)
            f.events.forEach { reducer.apply(it) }
            val actual = reducer.snapshot().items.filterNot { it is ChatItem.Note && it.text == "Контекст сжимается…" }.map { item ->
                when (item) {
                    is ChatItem.User -> ExpectedItem(item.id, "user", item.text, emptyList())
                    is ChatItem.Note -> ExpectedItem(item.id, "note", item.text, emptyList())
                    is ChatItem.Assistant -> ExpectedItem(item.id, "assistant", item.text, item.tools.map { it.id })
                }
            }
            val dir = File(System.getProperty("taskbridge.chatFixtures")).parentFile.resolve("compaction")
            val expected = TaskBridgeJson.decodeFromString(ListSerializer(ExpectedItem.serializer()), dir.resolve("pi-1.4.0-$name.expected.json").readText())
            assertEquals(expected, actual, name)
        }
    }

    @Test
    fun realAutomaticPiStreamKeepsCanonicalIdentityAndStableSegments() {
        val f = fixture("auto")
        val live = ChatReducer(f.task)
        f.events.forEach { live.apply(it); live.snapshot() }
        val replay = ChatReducer(f.task)
        f.events.forEach { replay.apply(it) }
        assertEquals(live.snapshot().items, replay.snapshot().items)
        val once = live.snapshot().items
        f.events.forEach { assertFalse(live.apply(it)) }
        assertEquals(once, live.snapshot().items)
        val snapshot = live.snapshot()
        val answers = snapshot.items.filterIsInstance<ChatItem.Assistant>()
        assertEquals(listOf("BEFORE", "AFTER"), answers.map { it.text })
        assertEquals(listOf("assistant-initial", "assistant-initial-segment-44"), answers.map { it.id })
        assertTrue(answers.all { it.canonicalId == "assistant-initial" && it.canonicalText == "BEFORE\n\nAFTER" })
        assertEquals(listOf(false, true), answers.map { it.segmentActions })
        assertEquals("assistant-initial", snapshot.newestAnswerId)
        assertEquals(listOf("tool-1"), answers.first().tools.map { it.id })
        assertTrue(answers.last().tools.isEmpty())
        assertTrue(answers.none { it.active })
        assertEquals(snapshot.items.size, snapshot.items.map { it.id }.toSet().size)
        assertEquals(2, snapshot.items.filterIsInstance<ChatItem.Note>().count { it.text.startsWith("Контекст сжат:") })
        val normalized = snapshot.items.filterNot { it is ChatItem.Note && it.text == "Контекст сжимается…" }
        assertTrue(normalized[1] is ChatItem.Assistant && normalized[2] is ChatItem.Note && normalized[3] is ChatItem.Assistant && normalized[4] is ChatItem.Note)
    }

    @Test
    fun stopSettlesBothSegmentsAndKeepsCanonicalIdentity() {
        val f = fixture("auto")
        val reducer = ChatReducer(f.task)
        f.events.filter { it.seq <= 229 }.forEach { reducer.apply(it) }
        reducer.apply(TaskEvent(taskId = f.task.id, seq = 230, type = "TASK_CANCELLED"))
        val answers = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>()
        assertEquals(listOf("BEFORE", "AFTER"), answers.map { it.text })
        assertTrue(answers.all { it.final && !it.active && it.canonicalId == "assistant-initial" })
        assertEquals("CANCELLED", answers.last().status)
    }

    @Test
    fun variantSelectionHidesAndRestoresCompactSegmentsAndNotes() {
        val f = fixture("auto")
        val reducer = ChatReducer(f.task)
        f.events.forEach { reducer.apply(it) }
        fun select(seq: Long, type: String, id: String) = reducer.apply(TaskEvent(
            taskId = f.task.id, seq = seq, type = type,
            data = buildJsonObject { put("turnSeq", 0); put("variantId", id) },
        ))
        select(235, "TURN_VARIANT_START", "v2")
        assertTrue(reducer.snapshot().items.none { it is ChatItem.Note })
        assertEquals("assistant-v2", reducer.snapshot().newestAnswerId)
        select(236, "TURN_VARIANT_SELECTED", "initial")
        val restored = reducer.snapshot()
        assertEquals("assistant-initial", restored.newestAnswerId)
        assertEquals(listOf("BEFORE", "AFTER"), restored.items.filterIsInstance<ChatItem.Assistant>().map { it.text })
        assertEquals(2, restored.items.filterIsInstance<ChatItem.Note>().count { it.text.startsWith("Контекст сжат:") })
    }

    @Test
    fun manualCompactAfterCompletionDoesNotCreateAnotherAnswer() {
        val f = fixture("manual")
        val reducer = ChatReducer(f.task)
        f.events.forEach { reducer.apply(it) }
        val snapshot = reducer.snapshot()
        assertEquals(1, snapshot.items.filterIsInstance<ChatItem.Assistant>().size)
        assertEquals("assistant-initial", snapshot.newestAnswerId)
        assertTrue(snapshot.items.last() is ChatItem.Note)
        assertTrue(snapshot.items.filterIsInstance<ChatItem.Assistant>().none { it.active })
    }

    @Test
    fun fullMessageEndReplacesDeltasWithoutRepeatingText() {
        val reducer = ChatReducer(Task(id = "a", status = "RUNNING"))
        val frames = listOf(
            """{"type":"message_start","message":{"role":"assistant"}}""",
            """{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"before"}}""",
            """{"type":"compaction_end","result":{"summary":"summary"}}""",
            """{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"after"}}""",
            """{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"beforeafter"}]}}""",
        )
        frames.forEachIndexed { i, frame ->
            reducer.apply(TaskEvent(taskId = "a", seq = i + 1L, type = "PI_EVENT", data = buildJsonObject { put("pi", TaskBridgeJson.parseToJsonElement(frame)) }))
        }
        assertEquals(listOf("before", "after"), reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>().map { it.text })
    }

    @Test
    fun failedOrCancelledCompactDoesNotSplitOrClaimSuccess() {
        for (error in listOf("\"errorMessage\":\"failed\"", "\"aborted\":true", "\"cancelled\":true")) {
            val reducer = ChatReducer(Task(id = "a", status = "RUNNING"))
            val frames = listOf(
                """{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"before"}}""",
                """{"type":"compaction_end","result":{"summary":"summary"},$error}""",
                """{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"after"}}""",
            )
            frames.forEachIndexed { i, frame ->
                reducer.apply(TaskEvent(taskId = "a", seq = i + 1L, type = "PI_EVENT", data = buildJsonObject { put("pi", TaskBridgeJson.parseToJsonElement(frame)) }))
            }
            assertEquals(1, reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>().size)
            assertTrue(reducer.snapshot().items.filterIsInstance<ChatItem.Note>().none { it.text.startsWith("Контекст сжат:") })
        }
    }
}
