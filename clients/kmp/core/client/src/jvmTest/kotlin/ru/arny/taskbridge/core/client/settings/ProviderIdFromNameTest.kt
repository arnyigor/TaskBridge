package ru.arny.taskbridge.core.client.settings

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * ID подключения выводится из названия, а не набирается руками.
 *
 * Правило принадлежит серверу (`src/providers/pi-provider-profiles.mjs`): запись,
 * которой владеет TaskBridge, начинается с `` и содержит только `[a-z0-9-]`,
 * до 48 символов после префикса. Человек об этом знать не должен — но слаг обязан
 * этому правилу соответствовать, иначе «Сохранить» молча не сработает.
 */
class ProviderIdFromNameTest {

    /** То же правило, что в `ProviderEditorState.ready` и в серверном валидаторе. */
    private val idPattern = Regex("^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$")

    @Test
    fun latinNameBecomesSlug() {
        assertEquals("my-deepseek", providerIdFromName("My DeepSeek"))
        assertEquals("openrouter", providerIdFromName("OpenRouter"))
    }

    @Test
    fun cyrillicNameIsTransliterated() {
        assertEquals("moy-deepseek", providerIdFromName("Мой DeepSeek"))
        assertEquals("lokalnyy-server", providerIdFromName("Локальный сервер"))
        // Мягкий и твёрдый знаки не превращаются в дефисы, иначе «подъезд» = «pod-ezd».
        assertEquals("podezd", providerIdFromName("Подъезд"))
        assertEquals("sol", providerIdFromName("Соль"))
    }

    @Test
    fun punctuationAndSpacesCollapseIntoOneDash() {
        assertEquals("my-provider", providerIdFromName("  my  —  provider!!  "))
        assertEquals("a-b", providerIdFromName("A / B"))
    }

    @Test
    fun emptyOrSymbolOnlyNameStillGivesAValidId() {
        assertEquals("provider", providerIdFromName(""))
        assertEquals("provider", providerIdFromName("!!! ???"))
        // Пустое имя и имя без букв дают один и тот же slug — второй получает суффикс.
        assertEquals("provider-2", providerIdFromName("", listOf("provider")))
        assertTrue(providerIdFromName("   ").matches(idPattern))
    }

    @Test
    fun longNameIsCutAndStillMatchesTheServerRule() {
        val id = providerIdFromName("очень длинное название подключения к локальному серверу llama cpp")
        assertTrue(id.length <= 51, " плюс не больше 48 символов: $id")
        assertTrue(id.matches(idPattern), id)
        assertTrue(!id.endsWith("-"), "хвостовой дефис сервер отвергает: $id")
    }

    @Test
    fun duplicateNamesGetASuffix() {
        val taken = listOf("ollama", "moy-deepseek")
        assertEquals("ollama-2", providerIdFromName("Ollama", taken))
        assertEquals("moy-deepseek-2", providerIdFromName("Мой DeepSeek", taken))
        assertEquals("moy-deepseek-3", providerIdFromName("Мой DeepSeek", taken + "moy-deepseek-2"))
    }

    @Test
    fun suffixNeverBreaksTheLengthLimit() {
        val long = "Очень длинное название подключения к локальному серверу llama cpp"
        val first = providerIdFromName(long)
        val second = providerIdFromName(long, listOf(first))
        assertTrue(second.matches(idPattern), second)
        assertTrue(second.endsWith("-2"), second)
        // Хвост суффикса съедает два символа слага, а не вылезает за лимит сервера.
        assertTrue(
            first.startsWith(second.removeSuffix("-2")),
            "$first / $second",
        )
    }

    @Test
    fun templateNamesGiveTemplateIds() {
        // Клик по шаблону заполняет название, и ID получается ожидаемый.
        assertEquals("ollama", providerIdFromName("Ollama"))
        assertEquals("openai", providerIdFromName("OpenAI"))
        assertEquals("lokalnyy-lan", providerIdFromName("Локальный / LAN"))
    }
}
