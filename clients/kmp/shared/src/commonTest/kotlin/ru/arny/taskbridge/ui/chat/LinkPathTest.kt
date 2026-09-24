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
}
