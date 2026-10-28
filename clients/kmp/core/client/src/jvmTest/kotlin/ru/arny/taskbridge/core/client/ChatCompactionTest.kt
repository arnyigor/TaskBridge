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

    private fun pi(seq: Long, json: String) = TaskEvent(taskId = "a", seq = seq, type = "PI_EVENT", data = buildJsonObject { put("pi", TaskBridgeJson.parseToJsonElement(json)) })

    @Test
    fun everyPageCutReconstructsTheSameCompactSnapshot() {
        val f = fixture("auto")
        val whole = ChatReducer(f.task)
        f.events.forEach { whole.apply(it) }
        for (cut in 1 until f.events.size) {
            val tail = ChatReducer(f.task, seedInitial = false)
            f.events.drop(cut).forEach { tail.apply(it) }
            tail.revealWindowStart(f.events[cut].seq)
            val cursor = tail.cursor
            tail.prependOlder(f.task, f.events.take(cut), reachedStart = true)
            assertEquals(whole.snapshot().items, tail.snapshot().items, "cut $cut")
            assertEquals("assistant-initial", tail.snapshot().newestAnswerId)
            assertEquals(cursor, tail.cursor)
        }
        val tail = ChatReducer(f.task, seedInitial = false)
        f.events.drop(15).forEach { tail.apply(it) }
        tail.revealWindowStart(f.events[15].seq)
        tail.prependOlder(f.task, f.events.subList(7, 15), reachedStart = false)
        tail.prependOlder(f.task, f.events.take(7), reachedStart = true)
        assertEquals(whole.snapshot().items, tail.snapshot().items, "three pages")
    }

    @Test
    fun backfillRetainsLateCompletionAfterSteer() {
        val task = Task(id = "a", status = "RUNNING")
        val reducer = ChatReducer(task, seedInitial = false)
        reducer.apply(pi(2, """{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"A"}}"""))
        reducer.apply(TaskEvent(taskId = "a", seq = 3, type = "USER_MESSAGE", message = "steer", data = buildJsonObject { put("mode", "steer") }))
        reducer.apply(pi(4, """{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"AB"}]}}"""))
        reducer.revealWindowStart(2)
        reducer.prependOlder(task, listOf(pi(1, """{"type":"message_start","message":{"role":"assistant"}}""")), reachedStart = true)
        val original = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>().first { it.canonicalId == "assistant-initial" }
        assertEquals("AB", original.text)
    }

    @Test
    fun backfillDoesNotReviveASnapshotCancelledAnswer() {
        val task = Task(id = "a", status = "RUNNING")
        val reducer = ChatReducer(task, seedInitial = false)
        reducer.apply(pi(2, """{"type":"message_start","message":{"role":"assistant"}}"""))
        reducer.apply(pi(3, """{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"A"}}"""))
        reducer.revealWindowStart(2)
        reducer.syncTask(task.copy(status = "CANCELLED"))
        reducer.prependOlder(task, listOf(pi(1, """{"type":"agent_start"}""")), reachedStart = true)
        val answer = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>().single()
        assertFalse(answer.active)
        assertTrue(answer.final)
        assertEquals("CANCELLED", answer.status)
    }

    @Test
    fun anOpenMessageReconcilesItsEndAfterBackfill() {
        val task = Task(id = "a", status = "RUNNING")
        val reducer = ChatReducer(task, seedInitial = false)
        reducer.apply(pi(4, """{"type":"message_start","message":{"role":"assistant"}}"""))
        reducer.apply(pi(5, """{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"after"}}"""))
        reducer.revealWindowStart(4)
        reducer.prependOlder(task, listOf(
            pi(1, """{"type":"message_start","message":{"role":"assistant"}}"""),
            pi(2, """{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"before"}}"""),
            pi(3, """{"type":"compaction_end","result":{"summary":"summary"}}"""),
        ), reachedStart = true)
        reducer.apply(pi(6, """{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"after!"}]}}"""))
        val snapshot = reducer.snapshot()
        assertEquals(listOf("before", "after!"), snapshot.items.filterIsInstance<ChatItem.Assistant>().map { it.text })
        assertEquals("assistant-initial", snapshot.newestAnswerId)
        assertTrue(snapshot.items.filterIsInstance<ChatItem.Assistant>().none { it.partial })
    }

    @Test
    fun lateAbortedOrphanUsesTheReconstructedPrefixNotTheNewAnswer() {
        val task = Task(id = "a", status = "RUNNING")
        val reducer = ChatReducer(task, seedInitial = false)
        reducer.apply(pi(4, """{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"A"}}"""))
        reducer.apply(TaskEvent(taskId = "a", seq = 5, type = "USER_MESSAGE", message = "steer", data = buildJsonObject { put("mode", "steer") }))
        reducer.apply(pi(6, """{"type":"message_start","message":{"role":"assistant"}}"""))
        reducer.apply(pi(7, """{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"N"}}"""))
        reducer.revealWindowStart(4)
        reducer.prependOlder(task, listOf(
            pi(1, """{"type":"message_start","message":{"role":"assistant"}}"""),
            pi(2, """{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"P"}]}}"""),
            pi(3, """{"type":"message_start","message":{"role":"assistant"}}"""),
        ), reachedStart = true)
        reducer.apply(pi(8, """{"type":"message_end","message":{"role":"assistant","stopReason":"aborted","content":[{"type":"text","text":"A"}]}}"""))
        val answers = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>()
        assertEquals(listOf("P\n\nA", "N"), answers.map { it.text })
        assertEquals("assistant-5", reducer.snapshot().newestAnswerId)
    }

    @Test
    fun overlappingBackfillDoesNotMisrouteTheLateOrphan() {
        val task = Task(id = "a", status = "RUNNING")
        val reducer = ChatReducer(task, seedInitial = false)
        val delta = pi(4, """{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"A"}}""")
        val steer = TaskEvent(taskId = "a", seq = 5, type = "USER_MESSAGE", message = "steer", data = buildJsonObject { put("mode", "steer") })
        reducer.apply(delta)
        reducer.apply(steer)
        reducer.apply(pi(6, """{"type":"message_start","message":{"role":"assistant"}}"""))
        reducer.apply(pi(7, """{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"N"}}"""))
        reducer.revealWindowStart(4)
        reducer.prependOlder(task, listOf(
            pi(1, """{"type":"message_start","message":{"role":"assistant"}}"""),
            pi(2, """{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"P"}]}}"""),
            pi(3, """{"type":"message_start","message":{"role":"assistant"}}"""), delta, steer,
        ), reachedStart = true)
        reducer.apply(pi(8, """{"type":"message_end","message":{"role":"assistant","stopReason":"aborted","content":[{"type":"text","text":"AB"}]}}"""))
        assertEquals(listOf("P\n\nAB", "N"), reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>().map { it.text })
    }

    @Test
    fun aNewerTurnsToolCanFinishAfterTheOlderPrefixArrives() {
        val task = Task(id = "a", status = "RUNNING")
        val reducer = ChatReducer(task, seedInitial = false)
        reducer.apply(pi(2, """{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"A"}}"""))
        reducer.apply(TaskEvent(taskId = "a", seq = 3, type = "USER_MESSAGE", message = "steer", data = buildJsonObject { put("mode", "steer") }))
        reducer.apply(pi(4, """{"type":"message_start","message":{"role":"assistant"}}"""))
        reducer.apply(pi(5, """{"type":"tool_execution_start","toolCallId":"t","toolName":"read","args":{"path":"sample.txt"}}"""))
        reducer.revealWindowStart(2)
        reducer.prependOlder(task, listOf(pi(1, """{"type":"message_start","message":{"role":"assistant"}}""")), reachedStart = true)
        reducer.apply(pi(6, """{"type":"tool_execution_end","toolCallId":"t","toolName":"read"}"""))
        val answer = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>().last()
        assertEquals("assistant-3", answer.id)
        assertEquals(ru.arny.taskbridge.core.client.chat.ToolState.DONE, answer.tools.single().state)
    }

    @Test
    fun completedToolsAndProgressSurviveBackfillAfterSteer() {
        val task = Task(id = "a", status = "RUNNING")
        val reducer = ChatReducer(task, seedInitial = false)
        reducer.apply(pi(2, """{"type":"tool_execution_start","toolCallId":"s","toolName":"subagent","args":{"agent":"worker","task":"public test"}}"""))
        reducer.apply(TaskEvent(taskId = "a", seq = 3, type = "USER_MESSAGE", message = "steer", data = buildJsonObject { put("mode", "steer") }))
        reducer.apply(pi(4, """{"type":"tool_execution_end","toolCallId":"s","toolName":"subagent","result":{"details":{"results":[{"agent":"worker","messages":[{"role":"assistant","content":[{"type":"text","text":"done"}]}]}]}}}"""))
        reducer.revealWindowStart(2)
        val before = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>().first().tools.single()
        reducer.prependOlder(task, listOf(pi(1, """{"type":"message_start","message":{"role":"assistant"}}""")), reachedStart = true)
        val after = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>().first().tools.single()
        assertEquals(before, after)
        assertTrue(after.progress.orEmpty().contains("done"))
        assertEquals("assistant-3", reducer.snapshot().newestAnswerId)
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
    fun largeToolHistoriesKeepSegmentStateAndCanonicalIdentity() {
        for (count in listOf(1_000, 10_000)) {
            val task = Task(id = "a", status = "RUNNING")
            val events = mutableListOf<TaskEvent>()
            fun add(json: String) { events += pi(events.size + 1L, json) }
            add("""{"type":"message_start","message":{"role":"assistant"}}""")
            add("""{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"before"}}""")
            var cut = 0
            for (i in 0 until count) {
                if (i == count / 2) {
                    add("""{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"before"}]}}""")
                    add("""{"type":"compaction_end","result":{"summary":"Public summary"}}""")
                    cut = events.size
                    add("""{"type":"message_start","message":{"role":"assistant"}}""")
                    add("""{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"after"}}""")
                }
                add("""{"type":"tool_execution_start","toolCallId":"t-$i","toolName":"read","args":{"path":"sample.txt"}}""")
                add("""{"type":"tool_execution_end","toolCallId":"t-$i","toolName":"read","isError":false}""")
            }
            add("""{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"after"}]}}""")
            add("""{"type":"agent_settled"}""")
            val whole = ChatReducer(task)
            val start = System.nanoTime()
            var maxSnapshotNs = 0L
            for (event in events) {
                whole.apply(event)
                if (event.seq % 250 == 0L) {
                    val snapshotStart = System.nanoTime()
                    whole.snapshot()
                    maxSnapshotNs = maxOf(maxSnapshotNs, System.nanoTime() - snapshotStart)
                }
            }
            val applyMs = (System.nanoTime() - start) / 1_000_000.0
            val answers = whole.snapshot().items.filterIsInstance<ChatItem.Assistant>()
            assertEquals(listOf("before", "after"), answers.map { it.text })
            assertEquals(listOf(count / 2, count / 2), answers.map { it.tools.size })
            assertTrue(answers.all { !it.active && it.tools.all { tool -> tool.state == ru.arny.taskbridge.core.client.chat.ToolState.DONE } })
            assertEquals(count, answers.flatMap { it.tools }.map { it.id }.toSet().size)
            val tail = ChatReducer(task, seedInitial = false)
            events.drop(cut).forEach { tail.apply(it) }
            tail.revealWindowStart(events[cut].seq)
            val backfillStart = System.nanoTime()
            tail.prependOlder(task, events.take(cut), reachedStart = true)
            val backfillMs = (System.nanoTime() - backfillStart) / 1_000_000.0
            assertEquals(whole.snapshot().items, tail.snapshot().items)
            assertEquals("assistant-initial", tail.snapshot().newestAnswerId)
            events.forEach { assertFalse(tail.apply(it)) }
            println("C14 KMP tools=$count events=${events.size} applyAndSnapshotsMs=$applyMs maxSnapshotMs=${maxSnapshotNs / 1_000_000.0} backfillMs=$backfillMs")
        }
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
