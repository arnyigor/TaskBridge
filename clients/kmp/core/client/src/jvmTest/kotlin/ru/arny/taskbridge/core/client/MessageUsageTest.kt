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

    @Test
    fun `время хода приходит событием TURN_METRICS и попадает в ответ`() {
        val log = events(
            """{"type":"message_start","message":{"role":"assistant"}}""",
            """{"type":"message_end","message":{"role":"assistant","model":"deepseek-flash","content":[{"type":"text","text":"ответ"}],"usage":{"input":2165,"output":4559,"cacheRead":1228928}}}""",
        )
        val reducer = ChatReducer(task)
        log.forEach { reducer.apply(it) }
        assertNull(answer(reducer).turnMetrics, "без события времени хода нет")

        reducer.apply(
            TaskEvent(
                taskId = task.id,
                seq = 10,
                type = "TURN_METRICS",
                data = buildJsonObject {
                    put("startedAt", "2026-11-09T13:00:00.000Z")
                    put("finishedAt", "2026-11-09T13:00:42.000Z")
                    put("durationMs", 42_000)
                    put("firstTokenMs", 900)
                    put("outputTokensPerSecond", 47.0)
                },
            )
        )

        val metrics = answer(reducer).turnMetrics
        assertEquals(42_000, metrics?.durationMs)
        assertEquals(900, metrics?.firstTokenMs)
        assertEquals(47.0, metrics?.outputTokensPerSecond)
    }

    @Test
    fun `cacheWrite учитывается отдельно и не входит в сумму токенов`() {
        val log = events(
            """{"type":"message_start","message":{"role":"assistant"}}""",
            """{"type":"message_end","message":{"role":"assistant","model":"deepseek-flash","content":[{"type":"text","text":"ответ"}],"usage":{"input":100,"output":10,"cacheRead":1000,"cacheWrite":7000}}}""",
        )
        val reducer = ChatReducer(task)
        log.forEach { reducer.apply(it) }
        val usage = answer(reducer).usage
        assertEquals(1_110, usage?.total)
        assertEquals(7_000, usage?.cacheWrite)
    }

    private fun metrics(seq: Long, durationMs: Long, ttft: Long? = null) = TaskEvent(
        taskId = task.id,
        seq = seq,
        type = "TURN_METRICS",
        data = buildJsonObject {
            put("startedAt", "2026-11-09T13:00:00.000Z")
            put("finishedAt", "2026-11-09T13:00:42.000Z")
            put("durationMs", durationMs)
            if (ttft != null) put("firstTokenMs", ttft)
        },
    )

    @Test
    fun `продолжение складывает сегменты одного ответа`() {
        val reducer = ChatReducer(task)
        events(
            """{"type":"message_start","message":{"role":"assistant"}}""",
            """{"type":"message_end","message":{"role":"assistant","model":"m","content":[{"type":"text","text":"часть"}],"usage":{"input":100,"output":10}}}""",
        ).forEach { reducer.apply(it) }

        // Два сегмента одного хода: время суммируется, TTFT остаётся первым.
        reducer.apply(metrics(5, 30_000, 900))
        reducer.apply(metrics(6, 12_000, 400))

        val item = answer(reducer)
        assertEquals(42_000, item.turnMetrics?.durationMs)
        assertEquals(900, item.turnMetrics?.firstTokenMs)
        assertEquals(2, item.metricsSegments)
        // Второй сегмент не имеет своей скорости: сумма сегментов её не даёт.
        assertNull(item.turnMetrics?.outputTokensPerSecond)
    }

    @Test
    fun `регенерация не складывается с прежней генерацией`() {
        val reducer = ChatReducer(task)
        events(
            """{"type":"message_start","message":{"role":"assistant"}}""",
            """{"type":"message_end","message":{"role":"assistant","model":"m","content":[{"type":"text","text":"старый"}],"usage":{"input":100,"output":10}}}""",
        ).forEach { reducer.apply(it) }
        reducer.apply(metrics(5, 30_000, 900))
        assertEquals(30_000, answer(reducer).turnMetrics?.durationMs)

        // Регенерация — новый вариант со своими числами и своим временем.
        reducer.apply(
            TaskEvent(
                taskId = task.id, seq = 6, type = "TURN_VARIANT_START",
                data = buildJsonObject { put("turnSeq", 0); put("variantId", "v2") },
            )
        )
        reducer.apply(metrics(7, 8_000, 200))

        val fresh = answer(reducer)
        assertEquals(8_000, fresh.turnMetrics?.durationMs)
        assertEquals(1, fresh.metricsSegments, "новая генерация — свой счёт сегментов")
        assertNull(fresh.usage, "токены нового варианта считаются отдельно")
        reducer.apply(TaskEvent(taskId = task.id, seq = 8, type = "TURN_VARIANT_SELECTED", data = buildJsonObject {
            put("turnSeq", 0); put("variantId", "initial")
        }))
        assertEquals(30_000, answer(reducer).turnMetrics?.durationMs)
        assertEquals(110, answer(reducer).usage?.total)
        reducer.apply(TaskEvent(taskId = task.id, seq = 9, type = "TURN_VARIANT_SELECTED", data = buildJsonObject {
            put("turnSeq", 0); put("variantId", "v2")
        }))
        assertEquals(8_000, answer(reducer).turnMetrics?.durationMs)
    }

    @Test
    fun journalAnchorKeepsLateMetricsOnTheOriginalAnswer() {
        val reducer = ChatReducer(task)
        events(
            """{"type":"agent_start"}""",
            """{"type":"message_end","message":{"role":"assistant","model":"m","content":[{"type":"text","text":"first"}],"usage":{"input":100,"output":10}}}""",
        ).forEach(reducer::apply)
        reducer.apply(TaskEvent(taskId = task.id, seq = 3, type = "USER_MESSAGE", data = buildJsonObject { put("text", "second") }))
        val anchored = metrics(4, 30_000).copy(data = buildJsonObject {
            put("durationMs", 30_000)
            put("messageEventSeq", 2)
            put("startEventSeq", 1)
            put("segmentId", "1")
        })
        reducer.apply(anchored)
        // A duplicate terminal frame with a new journal sequence is still the same segment.
        reducer.apply(anchored.copy(seq = 5))
        val answers = reducer.snapshot().items.filterIsInstance<ChatItem.Assistant>()
        assertEquals(30_000, answers.first().turnMetrics?.durationMs)
        assertEquals(1, answers.first().metricsSegments)
        assertNull(answers.last().turnMetrics)
    }

    @Test
    fun sizeCutHistoryRetainsUsageAndMetricsWhenOlderPrefixIsLoaded() {
        val log = events(
            """{"type":"agent_start"}""",
            """{"type":"message_start","message":{"role":"assistant"}}""",
            """{"type":"message_end","message":{"role":"assistant","model":"m","content":[{"type":"text","text":"answer"}],"usage":{"cacheRead":1000,"input":100,"output":10,"cacheWrite":0}}}""",
        ) + metrics(4, 42_000).copy(data = buildJsonObject {
            put("durationMs", 42_000)
            put("messageEventSeq", 3)
            put("startEventSeq", 1)
            put("segmentId", "1")
        })
        val full = ChatReducer(task)
        log.forEach(full::apply)
        val window = ChatReducer(task, seedInitial = false)
        log.drop(2).forEach(window::apply)
        window.prependOlder(task, log.take(2), reachedStart = true)
        assertEquals(answer(full).usage, answer(window).usage)
        assertEquals("m", answer(window).usageModel)
        assertEquals(answer(full).turnMetrics, answer(window).turnMetrics)
        assertEquals(1, answer(window).metricsSegments)
    }

    @Test
    fun invalidTimingIsNotRenderedAsACompletedMeasurement() {
        val reducer = ChatReducer(task)
        events("""{"type":"message_start","message":{"role":"assistant"}}""").forEach(reducer::apply)
        reducer.apply(metrics(2, -1))
        assertNull(answer(reducer).turnMetrics)
        reducer.apply(metrics(3, 400, 900))
        assertEquals(400, answer(reducer).turnMetrics?.durationMs)
        assertNull(answer(reducer).turnMetrics?.firstTokenMs)
    }

    @Test
    fun cachedInputWithoutOutputIsStillUsage() {
        val reducer = ChatReducer(task)
        events("""{"type":"message_end","message":{"role":"assistant","usage":{"cacheRead":1000,"output":0}}}""").forEach(reducer::apply)
        assertEquals(1000, answer(reducer).usage?.total)
        assertNull(answer(reducer).usage?.miss)
    }

    @Test
    fun lateMetricsSurvivePrependingHistoryAfterANewerUserMessage() {
        val prefix = events(
            """{"type":"agent_start"}""",
            """{"type":"message_start","message":{"role":"assistant"}}""",
        )
        val end = events("""{"type":"message_end","message":{"role":"assistant","model":"m","content":[{"type":"text","text":"answer"}],"usage":{"input":100,"output":10}}}""").single().copy(seq = 3)
        val newer = TaskEvent(taskId = task.id, seq = 4, type = "USER_MESSAGE", data = buildJsonObject { put("text", "new question") })
        val measurement = metrics(5, 42_000).copy(data = buildJsonObject {
            put("durationMs", 42_000)
            put("messageEventSeq", 3)
            put("startEventSeq", 1)
            put("segmentId", "1")
        })
        val window = ChatReducer(task, seedInitial = false)
        listOf(end, newer, measurement).forEach(window::apply)
        window.prependOlder(task, prefix, reachedStart = true)
        val answers = window.snapshot().items.filterIsInstance<ChatItem.Assistant>()
        assertEquals(42_000, answers.first().turnMetrics?.durationMs)
        assertEquals(110, answers.first().usage?.total)
        assertNull(answers.last().turnMetrics)
    }

    @Test
    fun continuationReplaysBothTokenAndTimingSegmentsWithoutPauses() {
        val first = events(
            """{"type":"agent_start"}""",
            """{"type":"message_start","message":{"role":"assistant"}}""",
            """{"type":"message_end","message":{"role":"assistant","model":"m","content":[{"type":"text","text":"first"}],"usage":{"input":100,"output":10}}}""",
        )
        val second = events(
            """{"type":"agent_start"}""",
            """{"type":"message_start","message":{"role":"assistant"}}""",
            """{"type":"message_end","message":{"role":"assistant","model":"m","content":[{"type":"text","text":"continued"}],"usage":{"input":120,"output":20}}}""",
        ).map { it.copy(seq = it.seq + 5) }
        fun segment(seq: Long, start: Long, end: Long, duration: Long) = metrics(seq, duration).copy(data = buildJsonObject {
            put("durationMs", duration)
            put("segmentId", start.toString())
            put("startEventSeq", start)
            put("messageEventSeq", end)
        })
        val log = first + segment(4, 1, 3, 30_000) +
            TaskEvent(taskId = task.id, seq = 5, type = "TASK_SUCCEEDED") +
            second + segment(9, 6, 8, 12_000)
        val reducer = ChatReducer(task)
        log.forEach(reducer::apply)
        assertEquals(250, answer(reducer).usage?.total)
        assertEquals(42_000, answer(reducer).turnMetrics?.durationMs)
        assertEquals(2, answer(reducer).metricsSegments)
        val restored = ChatReducer(task)
        log.forEach(restored::apply)
        assertEquals(answer(reducer).usage, answer(restored).usage)
        assertEquals(answer(reducer).turnMetrics, answer(restored).turnMetrics)
    }

    @Test
    fun providerAndLocalityComeFromTheFrameAndDisagreeingTotalIsFlagged() {
        val reducer = ChatReducer(task)
        events(
            """{"type":"message_start","message":{"role":"assistant"}}""",
            """{"type":"message_end","message":{"role":"assistant","model":"deepseek-flash","provider":"deepseek","isLocal":false,"content":[{"type":"text","text":"x"}],"usage":{"input":100,"output":10,"cacheRead":1000,"totalTokens":999999}}}""",
        ).forEach(reducer::apply)
        val item = answer(reducer)
        assertEquals("deepseek/deepseek-flash", item.usageModel)
        assertEquals(false, item.usageIsLocal)
        assertEquals(1_110, item.usage?.total, "итог считается по компонентам, а не по серверному полю")
        assertEquals(true, item.usage?.totalMismatch)
    }
}
