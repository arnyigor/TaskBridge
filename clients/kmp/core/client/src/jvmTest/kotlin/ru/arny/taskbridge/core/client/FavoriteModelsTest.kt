package ru.arny.taskbridge.core.client

import ru.arny.taskbridge.core.client.settings.AppSettings
import ru.arny.taskbridge.core.client.settings.KeyValueStore
import kotlin.test.Test
import kotlin.test.assertEquals

class FavoriteModelsTest {
    private val map = mutableMapOf<String, String>()
    private val settings = AppSettings(object : KeyValueStore {
        override fun get(key: String) = map[key]
        override fun put(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    }, newId = { "id" }, platform = "android")

    @Test
    fun favoritesSurviveAndClearCompletely() {
        assertEquals(emptySet(), settings.favoriteModels)
        // Model keys are "provider/id" and ids may hold slashes and colons.
        settings.favoriteModels = setOf("wormsoft/zai/glm-5.3-flash:NVFP4", "deepseek/deepseek-flash")
        assertEquals(setOf("wormsoft/zai/glm-5.3-flash:NVFP4", "deepseek/deepseek-flash"), settings.favoriteModels)
        settings.favoriteModels = emptySet()
        assertEquals(emptySet(), settings.favoriteModels)
        assertEquals(null, map["favoriteModels"])
    }
}
