package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.PlanFinding
import ru.arny.taskbridge.core.api.PlanProgress
import ru.arny.taskbridge.core.api.PlanStatus
import ru.arny.taskbridge.core.api.WorkspaceFileEntry
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

// FP-05C: карточка плана и переключатель в KMP. Те же решения и те же подписи, что
// в web (tests/web-follow-plan-view.test.mjs): два клиента не должны показывать
// разное про один и тот же серверный план.
class FollowPlanTest {
    private val running = PlanStatus(
        enabled = true,
        attached = true,
        state = "RUNNING_STEP",
        path = "docs/PLAN.md",
        revision = 7,
        stepId = "S-004",
        goal = "Стабилизировать историю",
        progress = PlanProgress(done = 3, total = 7),
        findings = listOf(PlanFinding(id = "F-002", priority = "P1", state = "OPEN", summary = "дубли при reconnect")),
    )

    @Test
    fun `the switch is called Po planu, not Plan Mode`() {
        assertEquals("По плану", FOLLOW_PLAN_LABEL)
        assertTrue("Plan Mode" !in FOLLOW_PLAN_LABEL)
        assertEquals(
            listOf("NOT_ATTACHED", "IDLE", "RUNNING_STEP", "REVIEWING", "PAUSED_REVIEW", "PAUSED", "COMPLETED"),
            PLAN_STATE_LABELS.keys.toList(),
        )
    }

    @Test
    fun `the headline names the file, the progress and the running step`() {
        assertEquals("docs/PLAN.md • 3/7 • выполняется шаг S-004", planHeadline(running))
        assertEquals("docs/PLAN.md • 3/7 • пауза", planHeadline(running.copy(state = "PAUSED")))
        assertEquals("План не подключён", planHeadline(PlanStatus(attached = false)))
        assertEquals(
            "PLAN.md • 7/7 • план завершён",
            planHeadline(PlanStatus(attached = true, path = "PLAN.md", state = "COMPLETED", progress = PlanProgress(7, 7))),
        )
    }

    @Test
    fun `open findings are shown by priority`() {
        assertEquals("P1 дубли при reconnect", planFindingsLine(running))
        val many = PlanStatus(
            attached = true,
            findings = listOf(
                PlanFinding(id = "F-3", priority = "P2", state = "OPEN", summary = "лог"),
                PlanFinding(id = "F-1", priority = "P0", state = "OPEN", summary = "потеря данных"),
                PlanFinding(id = "F-2", priority = "P1", state = "DONE", summary = "закрыто"),
            ),
        )
        assertEquals("P0 потеря данных (+1)", planFindingsLine(many))
        assertEquals("", planFindingsLine(null))
    }

    @Test
    fun `while a step runs only pause and STOP are available, and the switch pauses`() {
        val actions = planActions(running).associateBy { it.id }
        assertTrue(!actions.getValue("start").enabled, "no second step while one runs")
        assertTrue(actions.getValue("pause").enabled)
        assertTrue(actions.getValue("stop").enabled)
        assertTrue(actions.getValue("open").enabled)
        assertEquals("pause", planToggleOffAction(running), "turning the switch off never kills the running turn")
        assertEquals("none", planToggleOffAction(PlanStatus(state = "PAUSED")))
        assertEquals("none", planToggleOffAction(null))
    }

    @Test
    fun `a conflict blocks continue and offers adopting the file`() {
        val model = planCardModel(running.copy(state = "PAUSED_REVIEW", conflict = true))
        assertTrue(model.conflict!!.contains("изменён снаружи"))
        val actions = model.actions.associateBy { it.id }
        assertTrue(!actions.getValue("start").enabled)
        assertTrue(actions.getValue("reconcile").enabled)
    }

    @Test
    fun `a card without a plan stays out of the chat`() {
        val empty = planCardModel(PlanStatus(attached = false, enabled = true))
        assertTrue(!empty.visible)
        assertTrue(empty.actions.isEmpty())
        val model = planCardModel(running)
        assertTrue(model.visible)
        assertEquals("Стабилизировать историю", model.goal)
        assertEquals(6, model.actions.size)
    }

    @Test
    fun `the plan is picked from the project, not typed from memory`() {
        val entries = listOf(
            WorkspaceFileEntry(name = "PLAN.md", path = "PLAN.md", isFile = true),
            WorkspaceFileEntry(name = "docs", path = "docs", isFile = false),
            WorkspaceFileEntry(name = "notes.txt", path = "notes.txt", isFile = true),
            WorkspaceFileEntry(name = "IMPLEMENTATION_PLAN.MD", path = "docs/IMPLEMENTATION_PLAN.MD", isFile = true),
        )
        assertEquals(
            listOf("PLAN.md", "docs/IMPLEMENTATION_PLAN.MD"),
            planFileChoices(entries).map { it.path },
        )
        assertTrue(planFileChoices(null).isEmpty())
        assertTrue(planFileChoices(entries, limit = 0).isEmpty())
    }

    @Test
    fun `UI-02 one primary action per state, and the dialog states the plan in words`() {
        assertEquals("Выбрать файл .md", planPrimaryAction(PlanStatus(attached = false)).label)
        assertEquals("Начать выполнение", planPrimaryAction(PlanStatus(attached = true, state = "IDLE")).label)
        assertEquals("Пауза после шага", planPrimaryAction(PlanStatus(attached = true, state = "RUNNING_STEP")).label)
        assertEquals("Продолжить", planPrimaryAction(PlanStatus(attached = true, state = "PAUSED")).label)
        assertEquals("Обновить и сверить", planPrimaryAction(PlanStatus(attached = true, state = "IDLE", conflict = true)).label)
        assertEquals("Открыть результат", planPrimaryAction(PlanStatus(attached = true, state = "COMPLETED")).label)

        val meta = planMetaLine(
            PlanStatus(
                attached = true, state = "RUNNING_STEP", revision = 3, cycleNumber = 2,
                stepId = "S-002", stage = "PROGRESS", progress = PlanProgress(done = 1, total = 3),
            )
        )
        assertEquals("выполняется шаг • revision 3 • шагов 1/3 • цикл 2 • шаг S-002 • ответ идёт", meta)
        assertEquals("", planMetaLine(PlanStatus(attached = false)))
    }

    @Test
    fun `UI-02 errors are named, not generalised`() {
        assertTrue(planErrorText("PLAN_REVISION_CONFLICT", "PLAN_REVISION_CONFLICT: файл изменён").contains("изменён вне TaskBridge"))
        assertTrue(planErrorText("PLAN_UNKNOWN_OUTCOME", null).contains("автоматический повтор запрещён"))
        assertTrue(planErrorText("FOLLOW_PLAN_DISABLED", null).contains("followPlan.enabled"))
        assertTrue(planErrorText(null, "PLAN_INVALID: шаг S-002").let { it.contains("шаг S-002") && !it.startsWith("PLAN_INVALID") })
    }

    @Test
    fun `the icon itself carries the state`() {
        assertEquals(PlanIconState.OFF, planIconState(null))
        assertEquals(PlanIconState.OFF, planIconState(PlanStatus(attached = false, enabled = true)))
        assertEquals(PlanIconState.IDLE, planIconState(PlanStatus(attached = true, state = "IDLE")))
        assertEquals(PlanIconState.RUNNING, planIconState(PlanStatus(attached = true, state = "RUNNING_STEP")))
        assertEquals(PlanIconState.RUNNING, planIconState(PlanStatus(attached = true, state = "REVIEWING")))
        assertEquals(PlanIconState.ATTENTION, planIconState(PlanStatus(attached = true, state = "PAUSED_REVIEW")))
        assertEquals(PlanIconState.ATTENTION, planIconState(PlanStatus(attached = true, state = "IDLE", conflict = true)))
        assertEquals(PlanIconState.COMPLETED, planIconState(PlanStatus(attached = true, state = "COMPLETED")))
        assertEquals("По плану: шаг выполняется", planIconTitle(PlanStatus(attached = true, state = "RUNNING_STEP")))
    }

    @Test
    fun `a mode switched off on the server says so instead of disappearing`() {
        assertTrue(!planToggleEnabled(PlanStatus(enabled = false)))
        assertEquals("режим выключен на сервере", planToggleHint(PlanStatus(enabled = false)))
        assertTrue(planToggleEnabled(PlanStatus(enabled = true)))
        assertNull(planToggleHint(PlanStatus(enabled = true)))
        assertTrue(!planToggleEnabled(null), "unknown state is not a licence to start a plan")
        assertNull(planToggleHint(null))
    }

    @Test
    fun `the picker groups plans by project folder, root first`() {
        val entries = listOf(
            WorkspaceFileEntry(name = "PLAN.md", path = "PLAN.md", isFile = true),
            WorkspaceFileEntry(name = "DESIGN.md", path = "docs/DESIGN.md", isFile = true),
            WorkspaceFileEntry(name = "PLAN-2.md", path = "docs/PLAN-2.md", isFile = true),
            WorkspaceFileEntry(name = "index.js", path = "app/index.js", isFile = true),
        )
        val groups = planFileGroups(entries)
        assertEquals(listOf("", "docs"), groups.map { it.folder })
        assertEquals(listOf("PLAN.md"), groups[0].files.map { it.path })
        assertEquals(listOf("docs/DESIGN.md", "docs/PLAN-2.md"), groups[1].files.map { it.path })
        assertTrue(planFileGroups(null).isEmpty())
    }

    @Test
    fun `the attach path must be a relative Markdown file`() {
        assertNull(planPathProblem("docs/PLAN.md"))
        assertTrue(planPathProblem("")!!.contains("Укажите путь"))
        assertTrue(planPathProblem("C:\\work\\PLAN.md")!!.contains("относительным"))
        assertTrue(planPathProblem("/etc/PLAN.md")!!.contains("относительным"))
        assertTrue(planPathProblem("docs/PLAN.txt")!!.contains("Markdown"))
    }
}
