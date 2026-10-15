package ru.arny.taskbridge

import kotlin.test.Test
import kotlin.test.assertEquals

// Фаза 4: сервер считает эпизоды DEGRADED по сообщениям клиента. Решение
// «что докладывать» должно быть одно на устройство, а не на каждый открытый
// чат — иначе один обрыв превращался бы в N эпизодов по числу сессий.
class LinkReportTest {

    @Test
    fun noServerIsReconnectingEvenWithDegradedChats() {
        assertEquals("reconnecting" to "health probe failed", linkReportFor(online = false, degradedReasons = listOf("stream closed")))
    }

    @Test
    fun aBrokenStreamWithALiveServerIsDegradedAndCarriesTheReason() {
        assertEquals("degraded" to "stream closed", linkReportFor(online = true, degradedReasons = listOf("stream closed")))
    }

    @Test
    fun everyHealthyChatMeansLive() {
        assertEquals("live" to null, linkReportFor(online = true, degradedReasons = emptyList()))
    }

    @Test
    fun theFirstReasonWinsSoTheReportIsDeterministic() {
        // Причин может быть несколько (несколько чатов); докладываем одну, и она
        // не должна меняться от порядка обхода — иначе сервер видел бы «переходы».
        assertEquals("degraded" to "health probe failed (slow)", linkReportFor(online = true, degradedReasons = listOf("health probe failed (slow)", "stream closed")))
    }
}
