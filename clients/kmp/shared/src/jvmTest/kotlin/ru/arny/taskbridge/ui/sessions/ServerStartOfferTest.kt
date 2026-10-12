package ru.arny.taskbridge.ui.sessions

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Диалог кнопки «Перезапустить сервер» в трёх положениях сервера.
 *
 * 2026-10-12: сервер был убит, кнопку нажали с телефона — диалог обещал запуск, а
 * объяснение отправляло указывать каталог TaskBridge в настройках, которых на
 * телефоне нет. Единственное, что помогало, — запуск батника на компьютере.
 */
class ServerStartOfferTest {

    @Test
    fun anOnlineServerIsRestarted() {
        val offer = serverStartOffer(online = true, canStartLocalServer = true, phone = false)

        assertEquals("Перезапустить сервер TaskBridge?", offer.title)
        assertTrue(offer.canStart, "живой сервер перезапускается штатно")
        assertEquals("Перезапустить", offer.confirmLabel)
        assertTrue(offer.text.contains("Активные сессии будут прерваны"), offer.text)
    }

    @Test
    fun aStoppedServerOnDesktopIsStartedHidden() {
        val offer = serverStartOffer(online = false, canStartLocalServer = true, phone = false)

        assertEquals("Запустить сервер TaskBridge?", offer.title)
        assertTrue(offer.canStart)
        assertTrue(offer.text.contains("скрытым процессом"), offer.text)
    }

    @Test
    fun aPhoneDoesNotPromiseAStartItCannotDo() {
        val offer = serverStartOffer(online = false, canStartLocalServer = false, phone = true)

        assertEquals("Сервер на компьютере не запущен", offer.title)
        assertFalse(offer.canStart, "с телефона запустить нечем — кнопки запуска быть не должно")
        assertEquals("Понятно", offer.confirmLabel)
        assertTrue(offer.text.contains("на компьютере"), "называем место запуска: ${offer.text}")
        assertTrue(offer.text.contains("start.cmd"), "и чем именно запускать: ${offer.text}")
        // Совет про каталог — из десктопного случая: на телефоне такого пункта нет.
        assertFalse(offer.text.contains("Каталог TaskBridge"), offer.text)
        assertFalse(offer.text.contains("в настройках"), offer.text)
    }

    @Test
    fun aDesktopWithoutTheRepositoryAsksForTheDirectoryFirst() {
        val offer = serverStartOffer(online = false, canStartLocalServer = false, phone = false)

        assertTrue(offer.canStart, "каталог можно указать в настройках, запуск возможен")
        assertEquals("Запустить", offer.confirmLabel)
        assertTrue(offer.text.contains("Каталог TaskBridge"), offer.text)
        assertTrue(offer.text.contains("«Каталог TaskBridge»"), offer.text)
    }
}
