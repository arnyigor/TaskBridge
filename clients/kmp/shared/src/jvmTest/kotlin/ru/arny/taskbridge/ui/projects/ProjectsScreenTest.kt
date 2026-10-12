package ru.arny.taskbridge.ui.projects

import ru.arny.taskbridge.core.api.ProjectOverview
import ru.arny.taskbridge.core.api.ProjectOverviewTotals
import ru.arny.taskbridge.core.api.Invocation
import ru.arny.taskbridge.core.api.ProjectSummary
import ru.arny.taskbridge.core.api.ScheduleSpec
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Логика дашборда без Compose (MR-01): какие секции получаются, что написано под
 * именем проекта и в строке итогов. Проверяются строки, по которым оператор
 * решает, куда идти, — а не факт, что карточка нарисована.
 */
class ProjectsScreenTest {
    private fun project(
        id: String,
        name: String? = null,
        path: String? = null,
        pinned: Boolean = false,
        archived: Boolean = false,
        sessions: Int = 0,
        working: Int = 0,
        needsAttention: Int = 0,
        activeWork: Int = 0,
        lastActivityAt: String? = null,
    ) = ProjectSummary(
        id = id, name = name, path = path, pinned = pinned, archived = archived,
        sessions = sessions, working = working, needsAttention = needsAttention,
        activeWork = activeWork, lastActivityAt = lastActivityAt,
    )

    @Test
    fun sectionsSplitPinnedActiveAndArchivedInThatOrder() {
        val sections = projectSections(
            listOf(
                project("c", "Гамма", archived = true),
                project("a", "Альфа"),
                project("b", "Бета", pinned = true),
                project("d", "Дельта", pinned = true, archived = true),
            ),
            query = "",
        )
        assertEquals(listOf("b"), sections.pinned.map { it.id })
        assertEquals(listOf("a"), sections.active.map { it.id })
        // "d" is pinned AND archived: it must appear once, in the archive — a card in
        // two sections at the same time is not a list, it is a bug.
        assertEquals(listOf("c", "d"), sections.archived.map { it.id })
        assertEquals(4, sections.total, "every project is in exactly one section")
    }

    @Test
    fun theSearchMatchesNameAndPathAndKeepsSections() {
        val projects = listOf(
            project("a", "TaskBridge", path = "G:/work/taskbridge"),
            project("b", "Блог", path = "G:/sites/blog", pinned = true),
        )
        assertEquals(listOf("b"), projectSections(projects, "БЛОГ").pinned.map { it.id }, "case-insensitive by name")
        assertEquals(listOf("a"), projectSections(projects, "work/task").active.map { it.id }, "and by path")
        assertEquals(listOf("a"), projectSections(projects, "  TaskBridge  ").active.map { it.id }, "the query is trimmed")
        assertEquals(0, projectSections(projects, "нет такого").total)
        assertEquals(2, projectSections(projects, "").total, "an empty query keeps everything")
    }

    @Test
    fun theCountsLineKeepsTheNumbersThatMatter() {
        val busy = project("a", "TaskBridge", sessions = 41, working = 2, needsAttention = 1, activeWork = 3)
        assertEquals("сессий: 41 · работа: 3 · работают: 2 · внимание: 1", projectCountsLine(busy))
        assertEquals(
            "сессий: 41 · работа: 3 · работают: 2 · внимание: 1 · активность: 8 мин назад",
            projectCountsLine(busy, activity = "8 мин назад"),
        )
        // Zeroes are left out: «работают: 0» on every card is noise.
        val quiet = project("b", "Блог", sessions = 3)
        assertEquals("сессий: 3", projectCountsLine(quiet))
        assertEquals("сессий: 3 · активность: только что", projectCountsLine(quiet, activity = "только что"))
    }

    @Test
    fun theTotalsLineNamesEveryNumberTheScreenShows() {
        val overview = ProjectOverview(
            projects = emptyList(),
            unassignedSessions = 0,
            totals = ProjectOverviewTotals(projects = 4, pinned = 1, archived = 1, sessions = 92, working = 2, needsAttention = 1, workItems = 5, activeWork = 3),
        )
        assertEquals("проектов: 4 · сессий: 92 · работают: 2 · требуют внимания: 1 · работы: 3", projectTotalsLine(overview))
    }

    @Test
    fun sessionsOfARemovedProjectAreMentionedOnlyWhenThereAreAny() {
        assertNull(unassignedLine(0), "no orphan sessions — no line")
        val line = unassignedLine(3)
        assertTrue(line != null && line.contains("3"), "the operator is told how many: $line")
        assertTrue(line!!.contains("всех сессий"), "and where they stayed: $line")
    }

    @Test
    fun recurringLabelsDescribeTheActualScheduleAndResult() {
        assertEquals("Каждый день в 09:00", scheduleLabel(ScheduleSpec(kind = "daily", at = "09:00")))
        assertEquals("Пн в 08:30", scheduleLabel(ScheduleSpec(kind = "weekly", weekday = "mon", at = "08:30")))
        assertEquals("Каждые 2 ч.", scheduleLabel(ScheduleSpec(kind = "interval", everyMinutes = 120)))
        assertEquals("Каждые 3 дн.", scheduleLabel(ScheduleSpec(kind = "interval", everyMinutes = 4_320)))
        assertEquals("Последний запуск: ошибка", invocationLabel(Invocation(id = "i", recipeId = "r", status = "FAILED")))
        assertNull(invocationLabel(null))
    }

    @Test
    fun workItemStatusesAreHumanReadableWithoutHidingUnknownValues() {
        assertEquals("В работе", workItemStatusLabel("IN_PROGRESS"))
        assertEquals("Заблокировано", workItemStatusLabel("BLOCKED"))
        assertEquals("CUSTOM", workItemStatusLabel("CUSTOM"))
    }
}
