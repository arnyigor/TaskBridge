package ru.arny.taskbridge

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.v2.runComposeUiTest
import ru.arny.taskbridge.ui.chat.PlanPreviewList
import ru.arny.taskbridge.ui.theme.TaskBridgeTheme
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Регрессия краша 2026-10-26: предпросмотр свободного плана ронял Desktop с
 * «Key "44685" was already used» — LazyColumn получал ключ по hashCode строки, а
 * в плане много одинаковых строк (пустые, повторяющиеся пункты).
 */
@OptIn(ExperimentalTestApi::class)
class PlanPreviewListTest {
    @Test
    fun repeatedLinesDoNotBreakThePreview() = runComposeUiTest {
        val preview = buildString {
            appendLine("---")
            appendLine("taskbridge_plan: 1")
            appendLine("plan_id: p-next-steps")
            repeat(6) { appendLine() }               // пустые строки — одинаковые
            appendLine("## Шаги")
            repeat(4) { appendLine("### S-001 | TODO | P1 | Один и тот же шаг") } // повторы
            appendLine("## Обнаруженные проблемы")
        }
        // Данные именно того вида, который ломал ключ по hashCode: строки повторяются.
        val lines = preview.lines()
        assertTrue(lines.size > lines.toSet().size, "в предпросмотре есть повторяющиеся строки")
        setContent { TaskBridgeTheme(mode = "light") { PlanPreviewList(preview) } }
        waitForIdle()
        assertTrue(
            onAllNodesWithText("## Шаги").fetchSemanticsNodes().isNotEmpty() ||
                onAllNodesWithText("## Шаги", substring = true).fetchSemanticsNodes().isNotEmpty(),
            "предпросмотр отрисовался без падения на повторяющихся строках"
        )
    }
}
