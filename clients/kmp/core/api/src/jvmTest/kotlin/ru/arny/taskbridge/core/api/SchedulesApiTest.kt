package ru.arny.taskbridge.core.api

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * MR-06: schedules and invocations over the wire. The policy defaults matter as much
 * as the shapes — a phone that invents its own default would disagree with the
 * machine about what happens to a missed run.
 */
class SchedulesApiTest {
    private val requests = mutableListOf<HttpRequestData>()

    private fun api(handler: suspend MockRequestHandleScope.(HttpRequestData) -> io.ktor.client.request.HttpResponseData): TaskBridgeApi =
        TaskBridgeApi(HttpClient(MockEngine { request -> requests += request; handler(request) }), SimpleConnection("http://pc:8787"))

    private fun MockRequestHandleScope.json(text: String) =
        respond(ByteReadChannel(text), HttpStatusCode.OK, headersOf(HttpHeaders.ContentType to listOf("application/json")))

    private fun HttpRequestData.bodyText(): String = (body as? TextContent)?.text ?: ""

    private val schedule = """
        {"id":"sc-1","recipeId":"rc-1","enabled":true,
         "spec":{"kind":"weekly","at":"08:05","weekday":"mon"},
         "misfirePolicy":"RUN_ONCE","concurrencyPolicy":"SKIP_IF_RUNNING","notify":"action-required","approvalMode":"pause",
         "parameters":{"area":"android"},"nextRunAt":"2026-10-12T03:05:00.000Z","lastRunAt":null,
         "createdAt":"2026-10-11T12:00:00.000Z","updatedAt":"2026-10-11T12:00:00.000Z"}
    """.trimIndent()

    private val invocation = """
        {"id":"inv-1","recipeId":"rc-1","scheduleId":"sc-1","trigger":"schedule",
         "scheduledAt":"2026-10-12T03:05:00.000Z","startedAt":"2026-10-12T03:05:01.000Z","finishedAt":null,
         "status":"RUNNING","reason":null,"misfire":false,"parameters":{"area":"android"},
         "sessionId":"t1","verification":null,"workspaceRef":null,"resultArtifact":null}
    """.trimIndent()

    @Test
    fun aScheduleDecodesWithItsPoliciesAndSpec() = runBlocking<Unit> {
        val api = api { json("""{"items":[$schedule]}""") }
        val items = api.schedules(recipeId = "rc-1")
        assertEquals("http://pc:8787/api/schedules?recipeId=rc-1", requests.single().url.toString())
        val one = items.single()
        assertEquals("weekly", one.spec.kind)
        assertEquals("08:05", one.spec.at)
        assertEquals("mon", one.spec.weekday, "день недели — именем, не числом")
        assertEquals("RUN_ONCE", one.misfirePolicy)
        assertEquals("SKIP_IF_RUNNING", one.concurrencyPolicy)
        assertEquals("action-required", one.notify)
        assertEquals("pause", one.approvalMode)
        assertEquals("android", one.parameters["area"]!!.jsonPrimitive.content)
        assertTrue(one.enabled)

        requests.clear()
        api.schedules()
        assertEquals("http://pc:8787/api/schedules", requests.single().url.toString())
    }

    @Test
    fun creatingSendsOnlyWhatWasSetAndPausingSendsOneField() = runBlocking<Unit> {
        val api = api { json(schedule) }
        api.createSchedule(ScheduleRequest(recipeId = "rc-1", spec = ScheduleSpec(kind = "daily", at = "09:00")))
        val created = requests.single()
        assertEquals(HttpMethod.Post, created.method)
        val body = TaskBridgeJson.parseToJsonElement(created.bodyText()).jsonObject
        assertEquals("rc-1", body["recipeId"]?.jsonPrimitive?.content, "тело запроса: ${created.bodyText()}")
        assertEquals("daily", body["spec"]?.jsonObject?.get("kind")?.jsonPrimitive?.content, "тело запроса: ${created.bodyText()}")
        assertEquals("daily", body["spec"]!!.jsonObject["kind"]!!.jsonPrimitive.content)
        assertEquals("09:00", body["spec"]?.jsonObject?.get("at")?.jsonPrimitive?.content, "тело запроса: ${created.bodyText()}")
        // The policies come from the machine's defaults, not from the client.
        assertTrue("misfirePolicy" !in body, "политика пропусков не выдумывается клиентом: $body")
        assertTrue("notify" !in body)
        assertTrue("parameters" !in body)

        requests.clear()
        api.updateSchedule("sc-1", ScheduleRequest(enabled = false))
        val paused = TaskBridgeJson.parseToJsonElement(requests.single().bodyText()).jsonObject
        assertEquals("false", paused["enabled"]!!.jsonPrimitive.content)
        assertTrue("spec" !in paused, "пауза не переписывает расписание: $paused")
    }

    @Test
    fun runningByHandAndTheInvocationHistoryUseTheRightRoutes() = runBlocking<Unit> {
        val api = api { request ->
            // One invocation, one list: the run and the by-id call answer with the item
            // itself, the history with the envelope.
            when {
                request.url.encodedPath.endsWith("/run") -> json(invocation)
                request.url.encodedPath.startsWith("/api/invocations/") -> json(invocation)
                else -> json("""{"items":[$invocation]}""")
            }
        }
        val started = api.runScheduleNow("sc-1")
        assertEquals(HttpMethod.Post, requests.single().method)
        assertEquals("http://pc:8787/api/schedules/sc-1/run", requests.single().url.toString())
        assertEquals("schedule", started.trigger)
        assertEquals("t1", started.sessionId)
        assertTrue(started.running, "пока сессия работает, запуск RUNNING")
        assertFalse(started.misfire)

        requests.clear()
        val history = api.invocations(scheduleId = "sc-1", limit = 10)
        assertEquals("http://pc:8787/api/invocations?scheduleId=sc-1&limit=10", requests.single().url.toString())
        assertEquals("inv-1", history.single().id)
        assertEquals("android", history.single().parameters["area"]!!.jsonPrimitive.content)

        requests.clear()
        api.invocation("inv-1")
        assertEquals("http://pc:8787/api/invocations/inv-1", requests.single().url.toString())
    }

    @Test
    fun aTickCanBeAskedWhatItWouldDo() = runBlocking<Unit> {
        val api = api {
            json(
                """{"at":"2026-10-14T12:00:00.000Z",
                    "decisions":[{"scheduleId":"sc-1","action":"run","invocationId":"inv-1","sessionId":"t1","scheduledAt":"2026-10-14T09:00:00.000Z"},
                                 {"scheduleId":"sc-2","action":"busy","reason":"SKIP_IF_RUNNING"},
                                 {"scheduleId":"sc-3","action":"skipped","missed":2,"reason":"RUN_ONCE"}],
                    "reconciled":["inv-0"]}""".trimIndent(),
            )
        }
        val result = api.schedulerTick(now = "2026-10-14T12:00:00.000Z")
        val request = requests.single()
        assertEquals("http://pc:8787/api/scheduler/tick", request.url.toString())
        assertEquals("2026-10-14T12:00:00.000Z", TaskBridgeJson.parseToJsonElement(request.bodyText()).jsonObject["now"]!!.jsonPrimitive.content)
        assertEquals(listOf("run", "busy", "skipped"), result.decisions.map { it.action })
        assertEquals(2, result.decisions.last().missed)
        assertEquals("SKIP_IF_RUNNING", result.decisions[1].reason)
        assertEquals(listOf("inv-0"), result.reconciled)
    }

    @Test
    fun deletingAnswersWithTheScheduleItRemoved() = runBlocking<Unit> {
        val api = api { json("""{"ok":true,"removed":$schedule}""") }
        val removed = api.deleteSchedule("sc-1")
        assertEquals(HttpMethod.Delete, requests.single().method)
        assertEquals("sc-1", removed.id)
        assertEquals("rc-1", removed.recipeId)
        // A parameter of the schema travels as JSON, so a boolean stays a boolean.
        requests.clear()
        val api2 = api { json(schedule) }
        api2.updateSchedule("sc-1", ScheduleRequest(parameters = buildJsonObject { put("run_tests", JsonPrimitive(true)) }))
        val body = TaskBridgeJson.parseToJsonElement(requests.last().bodyText()).jsonObject
        assertEquals("true", body["parameters"]!!.jsonObject["run_tests"]!!.jsonPrimitive.content)
    }
}
