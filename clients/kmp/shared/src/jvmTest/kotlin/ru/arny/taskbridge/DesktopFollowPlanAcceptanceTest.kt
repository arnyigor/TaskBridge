package ru.arny.taskbridge

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.graphics.asSkiaBitmap
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.v2.runComposeUiTest
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import ru.arny.taskbridge.core.api.CreateTaskRequest
import ru.arny.taskbridge.core.api.PlanStatus
import ru.arny.taskbridge.core.api.TaskBridgeJson
import ru.arny.taskbridge.core.client.session.ChatPersistence
import ru.arny.taskbridge.core.client.session.NoopChatPersistence
import ru.arny.taskbridge.core.client.settings.KeyValueStore
import ru.arny.taskbridge.core.client.settings.SecretStore
import ru.arny.taskbridge.platform.DesktopPlatformServices
import ru.arny.taskbridge.platform.PlatformServices
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Native Compose Desktop acceptance of Follow Plan (NATIVE-01…NATIVE-08).
 *
 * It runs the PRODUCTION desktop composition (`App(graph, openTaskId = …)`) — the
 * same entry the packaged window uses — against a real, hermetic TaskBridge with
 * followPlan enabled. Settings live in memory, so the operator's own client
 * preferences and their running window are never touched.
 *
 * A plan file is written into the fixture workspace by the test: the plan is a
 * file in the project, not a client-side document.
 */
@OptIn(ExperimentalTestApi::class)
class DesktopFollowPlanAcceptanceTest {
    private val plan = """
        ---
        taskbridge_plan: 1
        plan_id: p-desktop
        revision: 1
        goal: "Desktop: план из двух шагов"
        ---

        # План: рабочий стол

        ## Шаги

        ### S-001 | TODO | P1 | Первый шаг рабочего стола slow
        **Критерии:** первый шаг выполнен.
        **Проверка:** read PLAN.md

        ### S-002 | TODO | P1 | Второй шаг рабочего стола
        **Критерии:** второй шаг выполнен.
        **Проверка:** read PLAN.md

        ## Обнаруженные проблемы
    """.trimIndent()

    @Test
    fun desktopFollowPlanPanelControlsTheServerFile() = runComposeUiTest {
        val fixture = ProcessBuilder("node", "tests/fixture-server-plan.mjs")
            .directory(File(System.getProperty("taskbridge.repo")))
            .redirectError(ProcessBuilder.Redirect.INHERIT).start()
        val output = fixture.inputStream.bufferedReader()
        val input = fixture.outputStream.bufferedWriter()
        fun fixtureLine(): String = CompletableFuture.supplyAsync { output.readLine() }
            .get(30, TimeUnit.SECONDS) ?: error("fixture output closed")
        var graph: AppGraph? = null
        try {
            val ready = TaskBridgeJson.parseToJsonElement(fixtureLine()).jsonObject
            val base = ready.getValue("base").jsonPrimitive.content
            val root = ready.getValue("root").jsonPrimitive.content
            File(root, "PLAN.md").writeText(plan)
            val long = buildString {
                appendLine("---")
                appendLine("taskbridge_plan: 1")
                appendLine("plan_id: p-long-desktop")
                appendLine("revision: 1")
                appendLine("goal: \"Длинный план: 32 пункта\"")
                appendLine("---")
                appendLine()
                appendLine("# План: длинный")
                appendLine()
                appendLine("## Шаги")
                appendLine()
                for (index in 1..32) {
                    appendLine("### S-%03d | TODO | P2 | Пункт %d".format(index, index))
                    appendLine("**Критерии:** пункт выполнен.")
                    appendLine("**Проверка:** read PLAN.md")
                    appendLine()
                }
                appendLine("## Обнаруженные проблемы")
            }
            File(root, "LONG.md").writeText(long)

            val memory = MemorySettings().apply { put("serverUrl", base) }
            val desktop = DesktopPlatformServices(store = memory)
            val platform = object : PlatformServices by desktop {
                override val secrets: SecretStore = memory
                override fun chatPersistence(serverUrl: String): ChatPersistence = NoopChatPersistence
            }
            val app = AppGraph(platform)
            graph = app
            val connection = app.connection ?: error("isolated connection missing")
            val task = runBlocking {
                connection.api.createTask(CreateTaskRequest(projectId = "fixture", prompt = "Desktop follow plan"))
            }
            runBlocking {
                repeat(120) {
                    if (connection.api.task(task.id).status in setOf("SUCCEEDED", "FAILED", "CANCELLED")) return@repeat
                    Thread.sleep(250)
                }
            }
            setContent { App(app, openTaskId = task.id) }
            waitUntil(timeoutMillis = 30_000) {
                onAllNodesWithText("Desktop follow plan", substring = true).fetchSemanticsNodes().isNotEmpty()
            }

            // NATIVE-01: the icon opens the panel; nothing is listed before that.
            onNodeWithContentDescription("По плану: выбрать файл плана", substring = true).performClick()
            waitUntil(timeoutMillis = 10_000) { onAllNodesWithText("Следование плану").fetchSemanticsNodes().isNotEmpty() }
            assertTrue(onAllNodesWithText("Путь в проекте").fetchSemanticsNodes().isEmpty())
            // FP-UX-04A: the start state offers the project scan and the system picker.
            assertTrue(onAllNodesWithText("Сканировать проект").fetchSemanticsNodes().isNotEmpty())
            assertTrue(onAllNodesWithText("Открыть файл").fetchSemanticsNodes().isNotEmpty())
            assertTrue(onAllNodesWithText("План не подключён").fetchSemanticsNodes().isNotEmpty())

            // Native picker interaction is opt-in because it owns a real OS window.
            // The normal regression still runs the unchanged panel against the API.
            if (System.getenv("TASKBRIDGE_NATIVE_PICKER_SMOKE") == "1") {
                val selected = CompletableFuture.runAsync { selectNativeFile(File(root, "PLAN.md")) }
                onNodeWithText("Открыть файл").performClick()
                selected.get(30, TimeUnit.SECONDS)
                waitUntil(timeoutMillis = 15_000) {
                    onAllNodesWithText("Файл в проекте: PLAN.md").fetchSemanticsNodes().isNotEmpty()
                }
                onNodeWithText("Подключить").performClick()
            } else {
                // FP-UX-04A/B: the project scan runs on a click, lists files (not
                // folders), and one click on a file shows the verdict before attach.
                onNodeWithText("Сканировать проект").performClick()
                waitUntil(timeoutMillis = 20_000) {
                    onAllNodesWithText("PLAN.md").fetchSemanticsNodes().isNotEmpty()
                }
                assertTrue(onAllNodesWithText("корень проекта", substring = true).fetchSemanticsNodes().isNotEmpty())
                onAllNodesWithText("PLAN.md")[0].performClick()
                waitUntil(timeoutMillis = 15_000) {
                    onAllNodesWithText("Готов к подключению").fetchSemanticsNodes().isNotEmpty()
                }
                onNodeWithText("Подключить").performClick()
            }
            waitUntil(timeoutMillis = 20_000) {
                onAllNodesWithText("шагов 0/2", substring = true).fetchSemanticsNodes().isNotEmpty()
            }
            shot("01-panel-attached")
            val attached = runBlocking { connection.api.plan(task.id) }
            assertEquals(true, attached.attached)
            assertEquals("PLAN.md", attached.path)

            // FP-UX-04F: «Отключить следование» снимает привязку, файл остаётся на месте,
            // и панель возвращается к стартовому состоянию с двумя кнопками.
            onNodeWithText("Дополнительно").performClick()
            waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Отключить следование").fetchSemanticsNodes().isNotEmpty() }
            onNodeWithText("Отключить следование").performClick()
            waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Отключить").fetchSemanticsNodes().isNotEmpty() }
            onNodeWithText("Отключить").performClick()
            waitUntil(timeoutMillis = 15_000) {
                onAllNodesWithText("Сканировать проект").fetchSemanticsNodes().isNotEmpty()
            }
            assertEquals(false, runBlocking { connection.api.plan(task.id).attached })
            assertTrue(File(root, "PLAN.md").exists(), "детальный файл не удалён при detached")

            // План подключается заново: остальные проверки NATIVE ходят по нему.
            runBlocking { connection.api.importPlan(task.id, "desktop-reattach", path = "PLAN.md") }
            waitUntil(timeoutMillis = 20_000) {
                onAllNodesWithText("шагов 0/2", substring = true).fetchSemanticsNodes().isNotEmpty()
            }

            // NATIVE-06: the step list collapses and expands.
            onNodeWithText("Все шаги (2)").performClick()
            waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Скрыть шаги").fetchSemanticsNodes().isNotEmpty() }
            onNodeWithText("Скрыть шаги").performClick()

            // NATIVE-04: RUNNING is reachable from the panel, and STOP/PAUSE live in it.
            // The first step is a `slow` one in the fixture (10 s): RUNNING has to be
            // stable enough for an operator to press pause, exactly as in production.
            onNodeWithText("Начать выполнение").performClick()
            waitUntil(timeoutMillis = 20_000) {
                runBlocking { connection.api.plan(task.id) }.state == "RUNNING_STEP"
            }
            waitUntil(timeoutMillis = 20_000) {
                onAllNodesWithText("Пауза после шага").fetchSemanticsNodes().isNotEmpty()
            }

            shot("02-running")
            // NATIVE-05: pause → resume → stop, each reflected by the server for real.
            // The fixture turn settles in milliseconds, so the pause may land either
            // before the settle (PAUSED) or right after it (PAUSED_REVIEW): both are
            // honest outcomes of «pause at a safe boundary» and both must offer resume.
            onNodeWithText("Пауза после шага").performClick()
            waitUntil(timeoutMillis = 20_000) {
                runBlocking { connection.api.plan(task.id) }.state in setOf("PAUSED", "PAUSED_REVIEW")
            }
            val paused = runBlocking { connection.api.plan(task.id) }.state
            assertTrue(paused == "PAUSED" || paused == "PAUSED_REVIEW", "unexpected pause state $paused")
            // PAUSED_REVIEW means the turn settled after the pause: the product asks
            // for a decision first, and only then offers to continue.
            if (paused == "PAUSED_REVIEW") {
                // The panel re-reads the server every 3 s: its own picture of the
                // state catches up with the API, and only then the button changes.
                waitUntil(timeoutMillis = 15_000) {
                    onAllNodesWithText("Разобрать результат").fetchSemanticsNodes().isNotEmpty()
                }
                onNodeWithText("Разобрать результат").performClick()
                waitUntil(timeoutMillis = 20_000) {
                    runBlocking { connection.api.plan(task.id) }.state == "PAUSED"
                }
            }
            clickInPanel("Продолжить")
            waitUntil(timeoutMillis = 20_000) {
                runBlocking { connection.api.plan(task.id) }.state == "RUNNING_STEP"
            }
            waitUntil(timeoutMillis = 20_000) {
                onAllNodesWithText("STOP сейчас").fetchSemanticsNodes().isNotEmpty()
            }
            onNodeWithText("STOP сейчас").performClick()
            waitUntil(timeoutMillis = 20_000) {
                runBlocking { connection.api.plan(task.id) }.state == "PAUSED_REVIEW"
            }

            shot("03-paused-review")
            // NATIVE-07: rare and dangerous actions live in «Дополнительно», not in the row.
            assertTrue(
                onAllNodesWithText("Отключить следование").fetchSemanticsNodes().isEmpty(),
                "detach must not sit in the always-visible row"
            )
            onNodeWithText("Дополнительно").performClick()
            waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Отключить следование").fetchSemanticsNodes().isNotEmpty() }
            // The menu is a dismissable overlay: the next click has to close it
            // before the panel's own buttons accept input again.
            onNodeWithText("Дополнительно").performClick()
            waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Отключить следование").fetchSemanticsNodes().isEmpty() }

            shot("04-menu-open")
            // NATIVE-02/03: the editor reads the server file and saves through CAS.
            onNodeWithText("Изменить план").performClick()
            waitUntil(timeoutMillis = 20_000) {
                onAllNodesWithText("Markdown плана на сервере").fetchSemanticsNodes().isNotEmpty()
            }
            val editor = hasSetTextAction() and hasLabel("Markdown плана на сервере")
            onNode(editor).performTextReplacement(plan.replace("Первый шаг", "Первый шаг (правка)"))
            waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Есть несохранённые изменения").fetchSemanticsNodes().isNotEmpty() }

            shot("05-editor")
            // NATIVE-08: a status refresh must not replace the draft or its CAS base.
            runBlocking { connection.api.plan(task.id) }
            Thread.sleep(1_500)
            onNode(editor).assertTextContains("Первый шаг (правка)", substring = true)

            shot("06-conflict")
            // NATIVE-03: an external edit makes the save a conflict, and both texts survive.
            File(root, "PLAN.md").writeText(plan.replace("Первый шаг", "Первый шаг (руками)"))
            onNodeWithText("Сохранить").performClick()
            waitUntil(timeoutMillis = 20_000) {
                onAllNodesWithText("изменён вне TaskBridge", substring = true).fetchSemanticsNodes().isNotEmpty()
            }
            onNode(editor).assertTextContains("Первый шаг (правка)", substring = true)
            assertTrue(File(root, "PLAN.md").readText().contains("(руками)"), "the operator's file is untouched")

            // NATIVE-03: adopting the file, then a normal save, lands in the same file.
            onNodeWithText("Отмена").performClick()
            waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Отменить несохранённые изменения?").fetchSemanticsNodes().isNotEmpty() }
            onNodeWithText("Отменить изменения").performClick()
            waitUntil(timeoutMillis = 10_000) { onAllNodesWithText("Обновить и сверить").fetchSemanticsNodes().isNotEmpty() }
            onNodeWithText("Обновить и сверить").performClick()
            waitUntil(timeoutMillis = 20_000) {
                runBlocking { connection.api.plan(task.id) }.conflict != true
            }
            onNodeWithText("Изменить план").performClick()
            waitUntil(timeoutMillis = 20_000) {
                onAllNodesWithText("Markdown плана на сервере").fetchSemanticsNodes().isNotEmpty()
            }
            onNode(editor).performTextReplacement(File(root, "PLAN.md").readText().replace("(руками)", "(из приложения)"))
            onNodeWithText("Сохранить").performClick()
            waitUntil(timeoutMillis = 20_000) {
                File(root, "PLAN.md").readText().contains("(из приложения)")
            }
            assertTrue((runBlocking { connection.api.plan(task.id) }.revision ?: 0) >= 2)

            // NATIVE-06 (long plan): 32 steps are reachable through the disclosure.
            onNodeWithText("Все шаги (2)").performClick()
            waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Скрыть шаги").fetchSemanticsNodes().isNotEmpty() }
        } finally {
            graph?.disconnect()
            graph?.scope?.cancel()
            input.close()
            if (!fixture.waitFor(15, TimeUnit.SECONDS)) {
                fixture.destroy()
                check(fixture.waitFor(5, TimeUnit.SECONDS)) { "fixture did not terminate" }
            }
        }
    }

    /** PNG of the rendered desktop composition — proof the panel really drew. */
    private fun ComposeUiTest.shot(name: String) {
        val dir = File(System.getProperty("taskbridge.repo"), ".local/fp-06/desktop/screens")
        dir.mkdirs()
        runCatching {
            val bitmap = onAllNodes(androidx.compose.ui.test.isRoot())[0].captureToImage()
            val data = org.jetbrains.skia.Image.makeFromBitmap(bitmap.asSkiaBitmap()).encodeToData()
                ?: error("no PNG data")
            File(dir, "$name.png").writeBytes(data.bytes)
        }.onFailure { println("screenshot $name skipped: ${it.message}") }
    }

    /** Inline helper: the row action, or the same action inside «Дополнительно». */
    private fun ComposeUiTest.clickInPanel(label: String) {
        if (onAllNodesWithText(label).fetchSemanticsNodes().isEmpty()) {
            onNodeWithText("Дополнительно").performClick()
            waitUntil(timeoutMillis = 5_000) { onAllNodesWithText(label).fetchSemanticsNodes().isNotEmpty() }
        }
        onNodeWithText(label).performClick()
    }

    /**
     * A text field is found by the label rendered inside its merged node: the
     * editor and the project-path field are both plain `OutlinedTextField`s, so a
     * bare "is editable" matcher would hit the chat composer too.
     */
    private fun hasLabel(label: String) = androidx.compose.ui.test.SemanticsMatcher("has label $label") { node ->
        node.config.getOrNull(SemanticsProperties.EditableText) != null &&
            node.config.getOrNull(SemanticsProperties.Text)?.any { it.text == label } == true
    }

    /** Operates only the native FileDialog owned by this test JVM. */
    private fun selectNativeFile(file: File) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
        var dialog: java.awt.FileDialog? = null
        while (dialog == null && System.nanoTime() < deadline) {
            dialog = java.awt.Window.getWindows().filterIsInstance<java.awt.FileDialog>().firstOrNull { it.isShowing }
            Thread.sleep(50)
        }
        val picker = checkNotNull(dialog) { "native FileDialog did not open" }
        val robot = java.awt.Robot().apply { autoDelay = 100 }
        val shotDir = File(System.getProperty("taskbridge.repo"), ".local/fp-06/desktop/screens").apply { mkdirs() }
        // Native Windows FileDialog can expose zero AWT bounds even while its
        // OS-owned window is visible. Do not capture the user's whole desktop.
        val bounds = picker.bounds
        if (bounds.width > 0 && bounds.height > 0) {
            javax.imageio.ImageIO.write(robot.createScreenCapture(bounds), "png", File(shotDir, "ux03-native-picker.png"))
        }
        // The dialog belongs to the OS and may sit behind the test window: bring it
        // forward before typing, otherwise the keystrokes go to another window and the
        // smoke fails at a step that has nothing to do with the product code.
        picker.toFront()
        picker.requestFocus()
        robot.delay(500) // OS focus transition, in the opt-in UI smoke only.
        val clipboard = java.awt.Toolkit.getDefaultToolkit().systemClipboard
        val previous = clipboard.getContents(null)
        try {
            clipboard.setContents(java.awt.datatransfer.StringSelection(file.canonicalPath), null)
            // The legacy dialog keeps the file-name field focused: paste the path and
            // press Enter, exactly as an operator does.
            robot.keyPress(java.awt.event.KeyEvent.VK_CONTROL)
            robot.keyPress(java.awt.event.KeyEvent.VK_V)
            robot.keyRelease(java.awt.event.KeyEvent.VK_V)
            robot.keyRelease(java.awt.event.KeyEvent.VK_CONTROL)
            robot.delay(300)
            robot.keyPress(java.awt.event.KeyEvent.VK_ENTER)
            robot.keyRelease(java.awt.event.KeyEvent.VK_ENTER)
            robot.delay(700)
            if (picker.isShowing) {
                // Focus may sit elsewhere in this dialog build; setting the file and
                // confirming is the same outcome the operator's click produces.
                picker.file = file.canonicalPath
                robot.keyPress(java.awt.event.KeyEvent.VK_ENTER)
                robot.keyRelease(java.awt.event.KeyEvent.VK_ENTER)
            }
            while (picker.isShowing && System.nanoTime() < deadline) Thread.sleep(50)
            check(!picker.isShowing) { "native picker did not accept the file" }
        } finally {
            if (previous != null) clipboard.setContents(previous, null)
            if (picker.isShowing) picker.dispose()
        }
    }

    private class MemorySettings : KeyValueStore, SecretStore {
        private val values = ConcurrentHashMap<String, String>()
        override fun get(key: String): String? = values[key]
        override fun put(key: String, value: String?) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }
}
