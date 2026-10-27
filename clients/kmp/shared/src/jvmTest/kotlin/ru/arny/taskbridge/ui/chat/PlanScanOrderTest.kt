package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.PlanScanFile
import ru.arny.taskbridge.core.api.PlanScanResult
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Живой отчёт 2026-10-26: «при сканировании проекта нет файлов во внутренних папках
 * 1-го уровня». Список на телефоне виден на ~5 строк, и при алфавитном порядке их
 * занимал корень проекта (AGENTS.md, README.md, CHANGELOG.md …), а файлы папок
 * оставались ниже сгиба. Теперь первыми идут те, что похожи на план, затем файлы
 * папок, и только потом остальной корень.
 */
class PlanScanOrderTest {

    private fun file(path: String, classification: String? = null) =
        PlanScanFile(name = path.substringAfterLast('/'), path = path, classification = classification)

    private fun result(vararg files: PlanScanFile) = PlanScanResult(files = files.toList(), total = files.size)

    @Test
    fun `файлы папок не прячутся за корнем проекта`() {
        val rows = planScanRows(
            result(
                file("AGENTS.md"), file("CHANGELOG.md"), file("README.md"),
                file("docs/PLAN.md"), file("docs/NEXT-STEPS.md"),
            )
        )
        assertEquals(
            listOf("docs/NEXT-STEPS.md", "docs/PLAN.md", "AGENTS.md", "CHANGELOG.md", "README.md"),
            rows.map { it.path },
        )
    }

    @Test
    fun `то, что уже похоже на план, идёт первым`() {
        val rows = planScanRows(
            result(
                file("AGENTS.md"), file("docs/PLAN.md", "VALID_MANAGED"), file("docs/TODO.md", "CONVERTIBLE"),
                file("zzz/other.md"),
            )
        )
        assertEquals(listOf("docs/PLAN.md", "docs/TODO.md", "zzz/other.md", "AGENTS.md"), rows.map { it.path })
    }

    @Test
    fun `пять первых строк больше не заняты одним корнем`() {
        val rows = planScanRows(
            result(
                file("AGENTS.md"), file("CHANGELOG.md"), file("README.md"), file("LICENSE.md"),
                file("docs/NEXT-STEPS.md"), file("docs/PLAN.md"),
            )
        )
        assertTrue(rows.take(5).any { it.folder.isNotBlank() }, "в первой пятёрке есть файл папки")
    }

    @Test
    fun `поиск сохраняет порядок и не теряет вложенные файлы`() {
        val all = result(file("README.md"), file("docs/NEXT-STEPS.md"), file("docs/PLAN.md"))
        assertEquals(
            listOf("docs/NEXT-STEPS.md", "docs/PLAN.md"),
            planScanRows(all, query = "docs").map { it.path },
        )
    }

    @Test
    fun `пустой результат не выдумывает строк`() {
        assertEquals(emptyList(), planScanRows(result()))
    }
}
