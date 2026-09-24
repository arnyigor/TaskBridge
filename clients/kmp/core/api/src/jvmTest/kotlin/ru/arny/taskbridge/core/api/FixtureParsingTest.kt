package ru.arny.taskbridge.core.api

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class FixtureParsingTest {
    private fun <T> parse(name: String, serializer: kotlinx.serialization.KSerializer<T>): T =
        TaskBridgeJson.decodeFromString(serializer, Fixtures.text(name))

    @Test
    fun info() {
        val info = parse("info.json", ApiInfo.serializer())
        assertEquals(1, info.apiVersion)
        assertNotNull(info.storeId)
        assertEquals(true, info.pi?.supported)
        assertIs<Compatibility.Ok>(compatibilityOf(info))
        assertTrue(info.fileLimits!!.uploadFileBytes > 0)
    }

    @Test
    fun anUnknownApiVersionIsRefused() {
        assertEquals(Compatibility.UnsupportedApi(2), compatibilityOf(ApiInfo(apiVersion = 2)))
    }

    @Test
    fun tasksAndProjects() {
        val tasks = parse("tasks.json", ListSerializer(Task.serializer()))
        assertTrue(tasks.isNotEmpty())
        assertTrue(tasks.all { it.taskStatus != TaskStatus.UNKNOWN })
        val failed = parse("task-failed.json", Task.serializer())
        assertEquals(TaskStatus.FAILED, failed.taskStatus)
        assertEquals("PI_SESSION_FAILED", failed.errorCode)
        assertEquals("Прочитай example.txt", parse("task-created.json", Task.serializer()).displayTitle)
        assertEquals("Тестовая сессия", parse("projects.json", ListSerializer(Project.serializer())).single().displayName)
    }

    @Test
    fun queuedPromptsCarryTheirSender() {
        val task = parse("task-with-queue.json", Task.serializer())
        val pending = task.pendingPrompts.single()
        assertEquals("из очереди", pending.text)
        assertEquals("fixture-msg-2", pending.commandId)
        assertEquals("fixture-desktop", pending.clientId)

        val events = parse("events-queue.json", ListSerializer(TaskEvent.serializer()))
        val queued = events.single { it.type == "PROMPT_QUEUED" }
        val delivered = events.last { it.type == "USER_MESSAGE" }
        assertEquals(queued.string("pendingId"), delivered.string("pendingId"))
        assertEquals("fixture-msg-2", delivered.string("commandId"))
        assertEquals(events.map { it.seq }.sorted(), events.map { it.seq }, "events come oldest first")
    }

    @Test
    fun piFramesAreReachable() {
        val events = parse("events-turn.json", ListSerializer(TaskEvent.serializer()))
        val tool = events.first { it.piFrame?.get("type")?.jsonPrimitive?.content == "tool_execution_start" }
        assertNotNull(tool.piFrame!!["toolCallId"])
    }

    @Test
    fun modelsWindowUploadAuth() {
        val models = parse("models.json", ModelCatalog.serializer())
        assertEquals(listOf("off", "low", "medium", "high"), models.thinkingLevels)
        assertEquals(2, models.models.size)
        val window = parse("events-tail.json", EventWindow.serializer())
        assertTrue(window.reachedStart)
        assertTrue(window.events.isNotEmpty())
        val upload = Fixtures.text("upload.json").let { TaskBridgeJson.parseToJsonElement(it).jsonObject }
        assertEquals(201, upload["status"]!!.jsonPrimitive.int)
        val result = TaskBridgeJson.decodeFromJsonElement(UploadResult.serializer(), upload["body"]!!)
        assertEquals("заметка.txt", result.files.single().name)
        assertEquals(false, parse("auth.json", AuthStatus.serializer()).enabled)
        assertTrue(parse("approvals.json", ListSerializer(Approval.serializer())).isEmpty())
    }

    @Test
    fun unknownFieldsAndEventTypesAreCarriedNotRejected() {
        val event = TaskBridgeJson.decodeFromString(
            TaskEvent.serializer(),
            """{"taskId":"t","seq":7,"type":"SOMETHING_NEW","data":{"x":1},"brandNewField":[1,2]}""",
        )
        assertEquals("SOMETHING_NEW", event.type)
        assertEquals(7, event.seq)
        val task = TaskBridgeJson.decodeFromString(Task.serializer(), """{"id":"t","status":"HIBERNATED","runtime":{"state":"LIVE"}}""")
        assertEquals(TaskStatus.UNKNOWN, task.taskStatus)
        val nullData = TaskBridgeJson.decodeFromString(TaskEvent.serializer(), """{"seq":1,"type":"STATUS","data":null}""")
        assertEquals(JsonObject(emptyMap()), nullData.data)
    }

    @Test
    fun errorsMapByCode() {
        fun of(name: String): ApiError {
            val root = TaskBridgeJson.parseToJsonElement(Fixtures.text(name)).jsonObject
            return apiErrorOf(root["status"]!!.jsonPrimitive.int, root["body"].toString())
        }
        assertIs<ApiError.NotFound>(of("error-not-found.json"))
        assertIs<ApiError.RouteNotFound>(of("error-route-not-found.json"))
        assertIs<ApiError.CommandConflict>(of("error-conflict.json"))
        assertIs<ApiError.InputInvalid>(of("error-input-invalid.json"))
        assertIs<ApiError.CommandInFlight>(apiErrorOf(409, """{"error":"Команда уже выполняется.","code":"ACCEPTED"}"""))
        assertIs<ApiError.UnknownAfterCrash>(apiErrorOf(409, """{"error":"x","code":"UNKNOWN_AFTER_CRASH"}"""))
        assertIs<ApiError.Busy>(apiErrorOf(409, """{"error":"x","code":"MODEL_BUSY"}"""))
        assertIs<ApiError.AuthRequired>(apiErrorOf(401, """{"error":"x","code":"AUTH_REQUIRED"}"""))
        val broken = apiErrorOf(502, "<html>bad gateway</html>")
        assertIs<ApiError.Other>(broken)
        assertTrue(broken.transient)
    }

    @Test
    fun everyJsonFixtureParsesAsJson() {
        for (name in Fixtures.names().filter { it.endsWith(".json") }) {
            TaskBridgeJson.parseToJsonElement(Fixtures.text(name))
        }
    }
}
