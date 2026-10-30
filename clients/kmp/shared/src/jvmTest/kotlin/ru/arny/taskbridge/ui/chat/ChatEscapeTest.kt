package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Порядок Esc в чате: закрывается то, что открыто последним. Ошибка здесь стоит
 * дорого — при открытом поиске Esc закрывал всю сессию (жалоба оператора 2026-10-30).
 */
class ChatEscapeTest {

    @Test
    fun searchClosesBeforeFilesAndStop() {
        assertEquals(ChatEscape.SEARCH, chatEscape(dialogOpen = false, searchOpen = true, filesOpen = true, canStop = true))
    }

    @Test
    fun dialogKeepsItsOwnEscape() {
        assertEquals(ChatEscape.DIALOG, chatEscape(dialogOpen = true, searchOpen = true, filesOpen = true, canStop = true))
    }

    @Test
    fun filePanelClosesWhenTheSearchIsClosed() {
        assertEquals(ChatEscape.FILE, chatEscape(dialogOpen = false, searchOpen = false, filesOpen = true, canStop = true))
    }

    @Test
    fun stopIsTheLastThingBeforeLeaving() {
        assertEquals(ChatEscape.STOP, chatEscape(dialogOpen = false, searchOpen = false, filesOpen = false, canStop = true))
        assertEquals(ChatEscape.NOTHING, chatEscape(dialogOpen = false, searchOpen = false, filesOpen = false, canStop = false))
    }
}
