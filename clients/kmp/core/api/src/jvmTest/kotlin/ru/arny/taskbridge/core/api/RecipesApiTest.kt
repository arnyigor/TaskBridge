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
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * MR-05: run recipes over the wire. The screens depend on these shapes, so the URL,
 * the query and the body are pinned — including the rule that a field left out keeps
 * its stored value, which is what lets one request type serve create and patch.
 */
class RecipesApiTest {
    private val requests = mutableListOf<HttpRequestData>()

    private fun api(handler: suspend MockRequestHandleScope.(HttpRequestData) -> io.ktor.client.request.HttpResponseData): TaskBridgeApi =
        TaskBridgeApi(HttpClient(MockEngine { request -> requests += request; handler(request) }), SimpleConnection("http://pc:8787"))

    private fun MockRequestHandleScope.json(text: String) =
        respond(ByteReadChannel(text), HttpStatusCode.OK, headersOf(HttpHeaders.ContentType to listOf("application/json")))

    private fun HttpRequestData.bodyText(): String = (body as? TextContent)?.text ?: ""

    private val recipe = """
        {"id":"rc-1","projectId":"p 1","workItemId":"wi-1","name":"Daily audit",
         "promptTemplate":"Проверь {{area}} относительно {{base_ref}}.",
         "parameters":{
           "base_ref":{"type":"string","default":"master"},
           "area":{"type":"enum","values":["all","android"],"default":"all"},
           "run_tests":{"type":"boolean","default":true},
           "attempts":{"type":"number","default":2}},
         "runtime":{"id":"pi","model":"local/qwen","thinking":"low"},
         "context":{"profile":"work-item+recap","includeMemory":true,"includeRecap":true,"includeGit":true},
         "workspace":{"strategy":"fresh-worktree","baseRef":"{{base_ref}}"},
         "verification":{"required":true,"command":null},
         "limits":{"timeoutMinutes":60},
         "createdAt":"2026-10-11T12:00:00.000Z","updatedAt":"2026-10-11T12:00:00.000Z"}
    """.trimIndent()

    @Test
    fun theListDecodesTheParameterSchema() = runBlocking<Unit> {
        val api = api { json("""{"items":[$recipe]}""") }
        val items = api.recipes(projectId = "p 1")
        assertEquals("http://pc:8787/api/recipes?projectId=p%201", requests.single().url.toString())
        val one = items.single()
        assertEquals("Daily audit", one.name)
        assertEquals(listOf("area", "attempts", "base_ref", "run_tests"), one.orderedParameters.map { it.first }, "параметры идут по имени")
        val area = one.parameters.getValue("area")
        assertEquals("enum", area.type)
        assertEquals(listOf("all", "android"), area.values)
        assertEquals("all", area.defaultText)
        assertEquals("master", one.parameters.getValue("base_ref").defaultText)
        assertTrue(one.parameters.getValue("run_tests").defaultBoolean)
        assertEquals(2.0, one.parameters.getValue("attempts").defaultNumber)
        assertEquals("work-item+recap", one.context.profile)
        assertEquals("{{base_ref}}", one.workspace.baseRef, "подстановку в Git base клиент видит как есть")
        assertEquals(60, one.limits.timeoutMinutes)
        assertEquals("wi-1", one.workItemId)

        requests.clear()
        api.recipes()
        assertEquals("http://pc:8787/api/recipes", requests.single().url.toString(), "без фильтра лишнего параметра нет")
    }

    @Test
    fun creatingSendsOnlyWhatWasSet() = runBlocking<Unit> {
        val api = api { json(recipe) }
        api.createRecipe(
            RecipeRequest(
                projectId = "p 1",
                name = "Daily audit",
                promptTemplate = "Проверь {{area}}",
                parameters = mapOf("area" to RecipeParameter(type = "enum", values = listOf("all", "android"), `default` = kotlinx.serialization.json.JsonPrimitive("all"))),
                runtime = RecipeRuntime(id = "pi", thinking = "low"),
            ),
        )
        val request = requests.single()
        assertEquals(HttpMethod.Post, request.method)
        assertEquals("http://pc:8787/api/recipes", request.url.toString())
        val body = TaskBridgeJson.parseToJsonElement(request.bodyText()).jsonObject
        assertEquals("p 1", body["projectId"]!!.jsonPrimitive.content)
        assertEquals("Daily audit", body["name"]!!.jsonPrimitive.content)
        assertTrue("workItemId" !in body, "не задано — на сервере останется пустым: $body")
        assertTrue("workspace" !in body, "вложенный объект не отправляется, если его не трогали: $body")
        assertTrue("limits" !in body)
        assertEquals("low", body["runtime"]!!.jsonObject["thinking"]!!.jsonPrimitive.content)
    }

    @Test
    fun patchingKeepsTheNestedObjectsItDoesNotMention() = runBlocking<Unit> {
        val api = api { json(recipe) }
        api.updateRecipe("rc-1", RecipeRequest(name = "Daily audit (v2)"))
        val request = requests.single()
        assertEquals(HttpMethod.Patch, request.method)
        assertEquals("http://pc:8787/api/recipes/rc-1", request.url.toString())
        val body = TaskBridgeJson.parseToJsonElement(request.bodyText()).jsonObject
        assertEquals("Daily audit (v2)", body["name"]!!.jsonPrimitive.content)
        // A default-filled runtime would reset the stored model and thinking level —
        // that is exactly what must not travel on a rename.
        assertTrue("runtime" !in body, "runtime не тронут: $body")
        assertTrue("context" !in body)
        assertTrue("parameters" !in body)

        requests.clear()
        api.updateRecipe("rc-1", RecipeRequest(runtime = RecipeRuntime(id = "omp", model = null, thinking = "medium")))
        val nested = TaskBridgeJson.parseToJsonElement(requests.single().bodyText()).jsonObject
        assertEquals("omp", nested["runtime"]!!.jsonObject["id"]!!.jsonPrimitive.content)
        assertEquals("medium", nested["runtime"]!!.jsonObject["thinking"]!!.jsonPrimitive.content)
    }

    @Test
    fun runningSendsTheChosenParametersAndReadsTheRenderedPrompt() = runBlocking<Unit> {
        val api = api {
            json(
                """
                {"task":{"id":"t1","status":"QUEUED","projectId":"p 1","prompt":"Проверь android относительно release.",
                          "title":"Daily audit"},
                 "invocation":{"recipeId":"rc-1","recipeName":"Daily audit","trigger":"manual",
                               "parameters":{"area":"android","base_ref":"release"},"at":"2026-10-11T12:30:00.000Z"},
                 "rendered":{"recipeId":"rc-1","projectId":"p 1","name":"Daily audit",
                             "prompt":"Проверь android относительно release.",
                             "parameters":{"area":"android"},"runtime":{"id":"pi"},"workspace":{"strategy":"fresh-worktree"}}}
                """.trimIndent(),
            )
        }
        val result = api.runRecipe("rc-1", parameters = mapOf("area" to "android", "base_ref" to "release"))
        val request = requests.single()
        assertEquals(HttpMethod.Post, request.method)
        assertEquals("http://pc:8787/api/recipes/rc-1/run", request.url.toString())
        val body = TaskBridgeJson.parseToJsonElement(request.bodyText()).jsonObject
        assertEquals("android", body["parameters"]!!.jsonObject["area"]!!.jsonPrimitive.content)
        assertEquals("release", body["parameters"]!!.jsonObject["base_ref"]!!.jsonPrimitive.content)
        assertEquals("t1", result.task.id)
        assertEquals("Проверь android относительно release.", result.task.prompt, "параметры уже подставлены сервером")
        assertEquals("rc-1", result.invocation?.recipeId)
        assertEquals("manual", result.invocation?.trigger)

        requests.clear()
        api.runRecipe("rc-1")
        val empty = TaskBridgeJson.parseToJsonElement(requests.single().bodyText()).jsonObject
        assertTrue("parameters" !in empty, "без параметров сервер берёт значения схемы: $empty")
    }

    @Test
    fun deletingAnswersWithTheRecipeItRemoved() = runBlocking<Unit> {
        val api = api { json("""{"ok":true,"removed":$recipe}""") }
        val removed = api.deleteRecipe("rc-1")
        assertEquals(HttpMethod.Delete, requests.single().method)
        assertEquals("rc-1", removed.id)
        assertEquals("Daily audit", removed.name)
    }
}
