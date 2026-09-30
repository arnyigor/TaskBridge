package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.LocalModelMetrics
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Диагностика чата объясняет отсутствие PP у внешнего сервера (Strata): промпт
 * последнего запроса пришёл из кеша беседы — движок его вспомнил, а не прочитал.
 * Числа скорости в этом случае не выдумываются: строка называет факт (сколько
 * токенов прочитано из сколько), потому что «новые / время промпт-фазы» на
 * таком промпте — накладные расходы: 163 новых токена за 1,5 с давали «108 tok/s».
 */
class StrataPpLineTest {
    @Test
    fun aPromptFromTheConversationCacheHasNoPpButSaysWhy() {
        val line = strataPpLine(LocalModelMetrics(
            available = true,
            source = "strata",
            pp = null,
            ppUnavailable = "conversation-cache",
            promptTokens = 55496,
            freshTokens = 163,
        ))
        assertEquals("PP: — промпт из кеша беседы (новых 163 из 55.5K)", line)
    }

    @Test
    fun aMeasuredPpHasNoLineOfItsOwn() {
        assertNull(strataPpLine(LocalModelMetrics(available = true, source = "strata", pp = 1150.0)))
        // У llama.cpp такого поля нет вовсе — строка молчит.
        assertNull(strataPpLine(LocalModelMetrics(available = true, source = "llama.cpp", pp = null)))
    }

    @Test
    fun theLineWorksWhenOnlyTheReasonArrived() {
        assertEquals(
            "PP: — промпт из кеша беседы",
            strataPpLine(LocalModelMetrics(available = true, ppUnavailable = "conversation-cache")),
        )
    }
}
