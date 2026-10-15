package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.ApiError
import ru.arny.taskbridge.core.client.session.LinkState
import ru.arny.taskbridge.core.client.session.describe
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/**
 * Панель «Диагностика» печатает состояние связи словами. После появления DEGRADED
 * (двухуровневый health, план 4.2) туда мог попасть сырой `toString` объекта —
 * «Degraded(attempt=2, inMillis=2000, reason=stream closed)»: по такой строке
 * оператор не может решить, ждать или проверять сеть.
 */
class LinkLabelTest {
    @Test
    fun `a degraded link says the computer answers and names the next try`() {
        val text = linkLabel(LinkState.Degraded(attempt = 2, inMillis = 2000, reason = "stream closed"))
        assertEquals("компьютер отвечает, поток событий оборван (попытка 2, через 2 с)", text)
        assertFalse(text.contains("Degraded"), "сырой toString не должен попадать в панель")
    }

    @Test
    fun `plain offline is a different sentence`() {
        val text = linkLabel(LinkState.Reconnecting(attempt = 3, inMillis = 4000, reason = "Connection refused"))
        assertEquals("нет связи с компьютером (попытка 3, через 4 с)", text)
    }

    @Test
    fun `live, connecting and failed keep their own words`() {
        assertEquals("поток подключён", linkLabel(LinkState.Live))
        assertEquals("подключаюсь", linkLabel(LinkState.Connecting))
        // Ошибка описывается общим describe(): у клиента одна формулировка на все экраны.
        val notFound = ApiError.NotFound("нет")
        assertEquals(describe(notFound), linkLabel(LinkState.Failed(notFound)))
    }
}
