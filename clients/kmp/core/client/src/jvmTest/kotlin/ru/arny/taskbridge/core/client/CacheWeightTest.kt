package ru.arny.taskbridge.core.client

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import ru.arny.taskbridge.core.api.TaskEvent
import ru.arny.taskbridge.core.client.session.CACHE_BUDGET_CHARS
import ru.arny.taskbridge.core.client.session.cacheWeight
import ru.arny.taskbridge.core.client.session.jsonWeight
import ru.arny.taskbridge.core.client.session.trimCacheToBudget
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Вес события для бюджета кэша (стабильность, 2026-10-14).
 *
 * Повод — падение приложения 2026-10-11: `OutOfMemoryError` на аллокации 108 МБ
 * внутри `JsonToStringWriter`, то есть вес события считался его же сериализацией
 * (`event.data.toString()`). Вложение в dropbox OnePlus 6T. Теперь вес считается
 * обходом дерева JsonElement, без построения строки.
 */
class CacheWeightTest {
    private fun event(data: JsonObject) = TaskEvent(taskId = "t", seq = 1, type = "PI_EVENT", data = data)

    @Test
    fun `the estimate tracks the serialized size, without building it`() {
        val data = buildJsonObject {
            put("pi", buildJsonObject {
                put("type", "tool_execution_end")
                put("toolName", "bash")
                put("result", "x".repeat(10_000))
            })
        }
        val serialized = data.toString().length
        val estimated = jsonWeight(data)
        // Оценка не обязана совпадать до символа (пробелы, кавычки), но должна быть
        // той же величиной: иначе бюджет кэша стал бы другим бюджетом.
        assertTrue(
            estimated > serialized / 2 && estimated < serialized * 2,
            "оценка $estimated против сериализации $serialized",
        )
    }

    @Test
    fun `a huge event does not become the cache's problem`() {
        val huge = event(buildJsonObject { put("result", "y".repeat(3_000_000)) })
        val small = event(buildJsonObject { put("type", "agent_start") })
        val events = mutableListOf(huge, small)
        val dropped = trimCacheToBudget(events)
        assertTrue(dropped, "перевес бюджета обязан что-то выбросить")
        // Гигантский кадр не кэшируется, а маленький остаётся: кадр больше бюджета
        // не должен сносить весь кэш.
        assertEquals(1, events.size, events.map { it.type }.toString())
        assertTrue(cacheWeight(events.first()) < CACHE_BUDGET_CHARS)
    }

    @Test
    fun `arrays and nesting are counted too`() {
        val data = buildJsonObject {
            put("items", buildJsonArray { repeat(5) { add(JsonPrimitive("item-$it")) } })
            put("nested", buildJsonObject { put("deep", buildJsonObject { put("value", "z".repeat(50)) }) })
        }
        assertTrue(jsonWeight(data) >= 5 * "item-0".length + 50, "вложенные массивы и объекты учитываются")
    }
}
