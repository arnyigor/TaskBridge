package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.client.session.OutgoingMessage
import ru.arny.taskbridge.core.client.session.SendMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Строка отправки над полем ввода.
 *
 * 2026-10-12: на этапе отправки строки не было вообще, поэтому «в очередь» становилось
 * видно только после ответа сервера — оператор описывал это как «сначала визуально
 * попадают в чат, а потом через некоторое время в очередь».
 */
class OutboxLabelTest {
    private fun message(mode: SendMode, status: OutgoingMessage.Status) = OutgoingMessage(
        commandId = "c1", text = "вопрос", fileNames = emptyList(), mode = mode, status = status,
    )

    @Test
    fun aQueuedMessageNamesItselfWhileItIsOnTheWay() {
        assertEquals(
            "Отправляю… если агент занят — встанет в очередь",
            outboxLabel(message(SendMode.QUEUE, OutgoingMessage.Status.Sending)),
        )
    }

    @Test
    fun steeringIsExpectedInTheConversationNotAboveTheComposer() {
        assertNull(outboxLabel(message(SendMode.STEER, OutgoingMessage.Status.Sending)), "steer идёт в ленту")
        assertNull(outboxLabel(message(SendMode.NOW, OutgoingMessage.Status.Sending)), "«вклиниться» тоже")
    }

    @Test
    fun uploadingAndFailuresKeepTheirWords() {
        assertEquals("Загружаю файлы…", outboxLabel(message(SendMode.QUEUE, OutgoingMessage.Status.Uploading)))
        assertEquals("Не отправлено: нет сети", outboxLabel(message(SendMode.QUEUE, OutgoingMessage.Status.Failed("нет сети"))))
        assertEquals("Нет связи, повтор 2…", outboxLabel(message(SendMode.QUEUE, OutgoingMessage.Status.Retrying(2, "нет сети"))), "причину повтор называет своим текстом, не словами причины")
        assertEquals(
            "Неизвестно, дошло ли сообщение (сервер перезапускался)",
            outboxLabel(message(SendMode.QUEUE, OutgoingMessage.Status.Unknown)),
        )
    }
}
