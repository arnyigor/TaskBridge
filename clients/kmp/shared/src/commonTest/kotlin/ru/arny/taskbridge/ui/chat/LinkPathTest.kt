package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertEquals

class LinkPathTest {

    @Test
    fun fileLinksBecomeWorkspacePathsWebLinksStayLinks() {
        assertEquals("README.md", workspaceLinkPath("README.md"))
        assertEquals("src/server.mjs", workspaceLinkPath("src/server.mjs#L120"))
        assertEquals("G:/Android/Taskbridge/README.md", workspaceLinkPath("G:/Android/Taskbridge/README.md"))
        assertEquals("G:\\proj\\a.kt", workspaceLinkPath("G:\\proj\\a.kt"))
        assertEquals("G:/proj/my file.kt", workspaceLinkPath("file:///G:/proj/my%20file.kt"))
        assertEquals("/home/u/a.kt", workspaceLinkPath("file:///home/u/a.kt"))
        assertEquals("c++/a.h", workspaceLinkPath("c++/a.h"))
        assertEquals(null, workspaceLinkPath("https://example.com/a.md"))
        assertEquals(null, workspaceLinkPath("mailto:a@b.c"))
        assertEquals(null, workspaceLinkPath("#section"))
    }

    // Пункт 162 плана: клик по ссылке из чата должен открывать файл НА НУЖНОЙ
    // строке, а не терять фрагмент и заставлять искать его глазами.
    @Test
    fun lineFragmentsBecomeARangeAndAreNotLost() {
        assertEquals(WorkspaceLink("src/a.kt", 120, 120), workspaceLinkTarget("src/a.kt#L120"))
        assertEquals(WorkspaceLink("src/a.kt", 120, 140), workspaceLinkTarget("src/a.kt#L120-L140"))
        assertEquals(WorkspaceLink("src/a.kt", 120, 140), workspaceLinkTarget("src/a.kt#L120-140"))
        // Перевёрнутый диапазон приводится к порядку, а не открывает файл «наоборот».
        assertEquals(WorkspaceLink("src/a.kt", 140, 140), workspaceLinkTarget("src/a.kt#L140-L120"))
        // Фрагмент без номера строки — это не диапазон: открываем файл целиком.
        assertEquals(WorkspaceLink("docs/api.md", null, null), workspaceLinkTarget("docs/api.md#usage"))
        assertEquals(WorkspaceLink("README.md", null, null), workspaceLinkTarget("README.md"))
        // Экранированный путь и диапазон вместе.
        assertEquals(WorkspaceLink("G:/proj/my file.kt", 7, 9), workspaceLinkTarget("file:///G:/proj/my%20file.kt#L7-L9"))
        // Веб-ссылка с якорем остаётся веб-ссылкой, даже если в якоре есть L-номер.
        assertEquals(null, workspaceLinkTarget("https://example.com/a.md#L10"))
        assertEquals(null, workspaceLinkTarget("#L10"))
    }
}
