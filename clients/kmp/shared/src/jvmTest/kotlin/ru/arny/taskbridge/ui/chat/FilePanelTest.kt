package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import ru.arny.taskbridge.core.api.SimpleConnection
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.client.session.ChatSession
import ru.arny.taskbridge.platform.DesktopPlatformServices
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The docked file panel on real bytes: a file opened from the chat is read through
 * the API and shown next to the chat, a second file gets its own tab, and a
 * Markdown file can be read as the document or as its source.
 */
@OptIn(ExperimentalTestApi::class)
class FilePanelTest {

    private val readme = "# План панели\n\nТекст документа.\n"
    private val gaps = "# Пробелы\n\nДругой файл.\n"

    private fun session(): Pair<ChatSession, HttpClient> {
        val json = headersOf(HttpHeaders.ContentType, "application/json")
        val http = HttpClient(MockEngine { request ->
            val path = request.url.parameters["path"].orEmpty()
            when {
                path.endsWith("PRODUCT_GAPS.md") -> respond(gaps, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "text/markdown"))
                path.endsWith("README.md") -> respond(readme, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "text/markdown"))
                else -> respond("""{"id":"t","status":"SUCCEEDED"}""", HttpStatusCode.OK, json)
            }
        })
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val session = ChatSession(
            TaskBridgeApi(http, SimpleConnection("http://pc:8787", clientId = "file-panel-test")),
            "t", scope, ids = { "id" }, now = { "2026-10-20T00:00:00Z" },
        )
        return session to http
    }

    @Test
    fun aFileOpensBesideTheChatAndASecondFileGetsItsOwnTab() = runComposeUiTest {
        val (chat, http) = session()
        val tabs = FileTabs()
        tabs.open(FileTarget.Workspace("README.md"))
        setContent { Panel(tabs, chat) }

        // The chat is still there, and the file is rendered as the document it is.
        onNodeWithTag("chat").assertExists()
        awaitSeen("План панели")
        awaitSeen("README.md")

        tabs.open(FileTarget.Workspace("docs/PRODUCT_GAPS.md"))
        waitForIdle()
        assertEquals(2, tabs.items.size)
        awaitSeen("Пробелы")
        awaitSeen("PRODUCT_GAPS.md")
        // The tab of the first file is still there: two files read side by side is the
        // whole point of the panel.
        awaitSeen("README.md")
        http.close()
    }

    @Test
    fun aMarkdownFileSwitchesBetweenDocumentAndSource() = runComposeUiTest {
        val (chat, http) = session()
        val tabs = FileTabs()
        tabs.open(FileTarget.Workspace("README.md"))
        setContent { Panel(tabs, chat) }

        awaitSeen("План панели")
        onNodeWithText("Текст").performClick()
        waitForIdle()
        // The source keeps the marker the renderer consumes.
        awaitSeen("# План панели", substring = true)
        http.close()
    }

    @Test
    fun closingTheTabClosesThePanel() = runComposeUiTest {
        val (chat, http) = session()
        val tabs = FileTabs()
        tabs.open(FileTarget.Workspace("README.md"))
        setContent { Panel(tabs, chat) }

        awaitSeen("План панели")
        onNodeWithContentDescription("Закрыть панель файлов").performClick()
        waitForIdle()
        assertTrue(tabs.items.isEmpty())
        http.close()
    }

    /**
     * The panel draws a file name twice (tab and path), so an exact-one check is wrong.
     * The file arrives from a coroutine, so the wait is part of the check.
     */
    private fun androidx.compose.ui.test.ComposeUiTest.awaitSeen(text: String, substring: Boolean = false) {
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText(text, substring = substring).fetchSemanticsNodes().isNotEmpty() }
    }

    @Test
    fun thePanelTakesWidthFromTheChatInsteadOfCoveringIt() = runComposeUiTest {
        val (chat, http) = session()
        val tabs = FileTabs()
        tabs.open(FileTarget.Workspace("README.md"))
        setContent { Panel(tabs, chat) }

        val chatPane = onNodeWithTag("chat").getBoundsInRoot()
        val closeAll = onNodeWithContentDescription("Закрыть панель файлов").getBoundsInRoot()
        assertTrue(closeAll.left > chatPane.right, "the panel starts where the chat ends: ${chatPane.right} vs ${closeAll.left}")
        assertTrue(chatPane.right - chatPane.left > 200.dp, "the chat keeps a readable width, was ${chatPane.right - chatPane.left}")
        http.close()
    }

    @Test
    fun aNarrowWindowOpensTheFileAsASheetNotAsADock() = runComposeUiTest {
        val (chat, http) = session()
        val tabs = FileTabs()
        tabs.open(FileTarget.Workspace("README.md"))
        setContent { Panel(tabs, chat, width = 600.dp) }

        awaitSeen("План панели")
        assertEquals(0, onAllNodesWithContentDescription("Закрыть панель файлов").fetchSemanticsNodes().size, "no dock on a narrow window")
        http.close()
    }

    @Composable
    private fun Panel(tabs: FileTabs, session: ChatSession, width: Dp = 1200.dp) {
        MaterialTheme {
            Box(Modifier.size(width, 800.dp)) {
                ChatWithFilePanel(
                    tabs = tabs,
                    session = session,
                    platform = DesktopPlatformServices(),
                    width = 440.dp,
                    onWidth = {},
                    onWidthCommitted = {},
                    onOpenPath = {},
                    onEscape = { false },
                ) {
                    Box(Modifier.fillMaxSize().testTag("chat")) { Text("лента") }
                }
            }
        }
    }
}
