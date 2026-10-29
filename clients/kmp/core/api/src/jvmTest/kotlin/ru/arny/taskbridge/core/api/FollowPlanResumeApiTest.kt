package ru.arny.taskbridge.core.api

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith

class FollowPlanResumeApiTest {
    @Test
    fun renewingTimeRequiresAnExplicitRequestAndKeepsRevision() = runBlocking {
        val bodies = mutableListOf<String>()
        val api = TaskBridgeApi(HttpClient(MockEngine { request ->
            assertEquals("/api/tasks/t1/plan/resume", request.url.encodedPath)
            bodies += (request.body as TextContent).text
            respond("""{"enabled":true,"attached":true,"state":"RUNNING_STEP"}""",
                HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }), SimpleConnection("http://pc:8787"))
        api.resumePlan("t1", 11, "first")
        api.resumePlan("t1", 11, "confirmed", renewTimeBudget = true)
        api.resumePlan("t1", 11, "confirmed-tranche", renewBudget = true)
        val normal = TaskBridgeJson.parseToJsonElement(bodies[0]).jsonObject
        val confirmed = TaskBridgeJson.parseToJsonElement(bodies[1]).jsonObject
        assertFalse("renewTimeBudget" in normal)
        assertEquals("true", confirmed["renewTimeBudget"]?.jsonPrimitive?.content)
        assertEquals("11", confirmed["expectedRevision"]?.jsonPrimitive?.content)
        val tranche = TaskBridgeJson.parseToJsonElement(bodies[2]).jsonObject
        assertEquals("true", tranche["renewBudget"]?.jsonPrimitive?.content)
        assertFalse("renewBudget" in normal)
        assertFalse("renewBudget" in confirmed)
    }

    @Test
    fun persistedPauseReasonIsDecodedForThePlanPanel() {
        val status = TaskBridgeJson.decodeFromString(PlanStatus.serializer(), """{"state":"PAUSED","pauseReason":{"code":"PLAN_BUDGET_EXCEEDED","message":"Cycle limit 20"}}""")
        assertEquals("Cycle limit 20", status.pauseReason?.message)
    }

    @Test
    fun budgetRejectionReachesTheUiAsAnActionableCode() = runBlocking {
        val api = TaskBridgeApi(HttpClient(MockEngine {
            respond("""{"code":"PLAN_BUDGET_EXCEEDED","error":"Time budget exhausted"}""",
                HttpStatusCode.Conflict, headersOf(HttpHeaders.ContentType, "application/json"))
        }), SimpleConnection("http://pc:8787"))
        val error = assertFailsWith<ApiException> { api.resumePlan("t1", 11, "resume") }
        assertEquals("PLAN_BUDGET_EXCEEDED", (error.error as ApiError.Busy).code)
    }
}
