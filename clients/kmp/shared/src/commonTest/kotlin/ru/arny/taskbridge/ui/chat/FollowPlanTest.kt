package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.PlanFinding
import ru.arny.taskbridge.core.api.PlanProgress
import ru.arny.taskbridge.core.api.PlanStatus
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
    fun `the attach path must be a relative Markdown file`() {
        assertNull(planPathProblem("docs/PLAN.md"))
        assertTrue(planPathProblem("")!!.contains("Укажите путь"))
        assertTrue(planPathProblem("C:\\work\\PLAN.md")!!.contains("относительным"))
        assertTrue(planPathProblem("/etc/PLAN.md")!!.contains("относительным"))
        assertTrue(planPathProblem("docs/PLAN.txt")!!.contains("Markdown"))
    }
}
