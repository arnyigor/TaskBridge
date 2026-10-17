package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Иконка «открыть папку сессии» в шапке чата.
 *
 * Папку открывает файловый менеджер на компьютере, поэтому у телефона кнопки быть не
 * должно — сервер такому клиенту отвечает 403; и у сессии без рабочей папки тоже:
 * открывать нечего, сервер ответил бы 404. Рендер кнопки требует устройства,
 * поэтому проверяется решение о видимости.
 */
class OpenFolderTest {
    @Test
    fun `desktop with a prepared workspace shows the button`() {
        assertEquals(true, canOpenSessionFolder("desktop", "G:\\Android\\Taskbridge"))
    }

    @Test
    fun `a phone never shows it`() {
        assertEquals(false, canOpenSessionFolder("android", "G:\\Android\\Taskbridge"))
    }

    @Test
    fun `no button while the workspace is not ready`() {
        assertEquals(false, canOpenSessionFolder("desktop", null))
        assertEquals(false, canOpenSessionFolder("desktop", ""))
        assertEquals(false, canOpenSessionFolder("desktop", "   "))
    }
}
