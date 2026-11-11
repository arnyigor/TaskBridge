package ru.arny.taskbridge.core.client.settings

import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Пресет, который форма отправляет вместе с новым подключением.
 *
 * Без `reasoning: true` сервер (`supportedThinkingLevels` в `src/model-catalog.mjs`)
 * отдаёт модели один уровень «off», и выбор размышлений в сессии показывает
 * «None» — на это и жаловался оператор.
 */
class ThinkingModelDefaultsTest {

    @Test
    fun presetMakesTheModelReason() {
        assertEquals(true, THINKING_MODEL_DEFAULTS["reasoning"]?.jsonPrimitive?.content?.toBoolean())
    }

    @Test
    fun unsupportedLevelsAreNullSoPiHidesThem() {
        val map = THINKING_MODEL_DEFAULTS["thinkingLevelMap"]!!.jsonObject
        // «minimal», «xhigh» и «max*» в рабочей конфигурации Strata/llama.cpp — null.
        assertTrue(map["minimal"] is kotlinx.serialization.json.JsonNull)
        assertTrue(map["xhigh"] is kotlinx.serialization.json.JsonNull)
        assertEquals("medium", map["medium"]?.jsonPrimitive?.content)
    }

    @Test
    fun compatUsesChatTemplateLikeTheWorkingLocalConfig() {
        val compat = THINKING_MODEL_DEFAULTS["compat"]!!.jsonObject
        assertEquals("chat-template", compat["thinkingFormat"]?.jsonPrimitive?.content)
        val kwargs = compat["chatTemplateKwargs"]!!.jsonObject
        assertEquals("\$var", "reasoning_effort".let { kwargs[it]!!.jsonObject.keys.first() })
    }
}
