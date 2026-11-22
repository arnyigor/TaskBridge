package ru.arny.taskbridge.core.client

import java.io.File
import kotlinx.serialization.json.*
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.TaskBridgeJson
import ru.arny.taskbridge.core.api.TaskEvent
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.core.client.chat.ChatReducer
import kotlin.test.Test
import kotlin.test.assertTrue

// Temporary private capture probe; replace with a minimal anonymized regression.
class LifecycleTailReplayTest {
    @Test fun terminalTailHasNoActiveAnswers() {
        val file = File(System.getProperty("taskbridge.repo"), ".local/stabilization/replay-private.json")
        val capture = TaskBridgeJson.parseToJsonElement(file.readText()).jsonObject
        val task = TaskBridgeJson.decodeFromJsonElement(Task.serializer(), capture.getValue("task"))
        val failures = mutableListOf<String>()
        for (window in capture.getValue("windows").jsonArray) {
            val w = window.jsonObject
            val reached = w["reachedStart"]?.jsonPrimitive?.booleanOrNull ?: false
            val reducer = ChatReducer(task, seedInitial = reached)
            for (raw in w.getValue("events").jsonArray) reducer.apply(TaskBridgeJson.decodeFromJsonElement(TaskEvent.serializer(), raw))
            for (initial in listOf(false, true)) {
                reducer.syncTask(task, initial = initial)
                for (detail in listOf(false, true)) {
                    val active = reducer.snapshot(detailed = detail).items.filterIsInstance<ChatItem.Assistant>().filter { it.active }
                    if (active.isNotEmpty()) failures += "tail=${w["tail"]} initial=$initial detailed=$detail active=" + active.joinToString { "${it.id}:${it.status}:${it.final}" }
                }
            }
        }
        assertTrue(failures.isEmpty(), failures.joinToString("\n"))
    }
}
