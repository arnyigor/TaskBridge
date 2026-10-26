package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.PlanAiModel
import ru.arny.taskbridge.core.api.PlanAiReview
import ru.arny.taskbridge.core.api.PlanAiStructural
import ru.arny.taskbridge.core.api.PlanAiVerdict
import ru.arny.taskbridge.core.api.PlanFinding
import ru.arny.taskbridge.core.api.PlanInspection
import ru.arny.taskbridge.core.api.PlanPreview
import ru.arny.taskbridge.core.api.PlanPreviewStep
import ru.arny.taskbridge.core.api.PlanProgress
import ru.arny.taskbridge.core.api.PlanScanFile
import ru.arny.taskbridge.core.api.PlanScanResult
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
        assertEquals(7, model.actions.size)
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
        // FP-UX-04A: стартовое состояние предлагает сканирование проекта.
        assertEquals("Сканировать проект", planPrimaryAction(PlanStatus(attached = false)).label)
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

    // --- FP-UX-04: сканирование, вердикт и ИИ ---

    @Test
    fun `DISC-03 DISC-04 the scan list holds files with a relative path`() {
        val scan = PlanScanResult(
            files = listOf(
                PlanScanFile(name = "PLAN.md", path = "PLAN.md", size = 2048, classification = "VALID_MANAGED"),
                PlanScanFile(name = "TODO.md", path = "docs/TODO.md", size = 900, classification = "CONVERTIBLE"),
                PlanScanFile(name = "readme.md", path = "docs/deep/readme.md", size = 10),
            ),
            total = 3,
        )
        val rows = planScanRows(scan)
        assertEquals(listOf("PLAN.md", "TODO.md", "readme.md"), rows.map { it.name })
        assertEquals(listOf("", "docs", "docs/deep"), rows.map { it.folder })
        assertEquals("управляемый план", rows[0].hint)
        assertEquals("нужен импорт", rows[1].hint)
        assertEquals("", rows[2].hint)
    }

    @Test
    fun `DISC-05 the search filters the loaded list instead of rescanning`() {
        val scan = PlanScanResult(
            files = listOf(
                PlanScanFile(name = "PLAN.md", path = "PLAN.md"),
                PlanScanFile(name = "release-notes.md", path = "docs/release-notes.md"),
            ),
            total = 2,
        )
        assertEquals(listOf("docs/release-notes.md"), planScanRows(scan, "RELEASE").map { it.path })
        assertEquals(listOf("docs/release-notes.md"), planScanRows(scan, "docs/").map { it.path })
        assertEquals(2, planScanRows(scan, "").size)
        assertTrue(planScanRows(scan, "нет такого").isEmpty())
        assertEquals("Файлы проекта не сканировались.", planScanEmptyText(null))
        assertTrue(planScanEmptyText(PlanScanResult()).contains("не найдено ни одного Markdown"))
        assertTrue(planScanEmptyText(scan, "нет такого").contains("ничего не найдено"))
    }

    @Test
    fun `a partial scan says so instead of pretending to be complete`() {
        val line = planScanStatusLine(PlanScanResult(total = 40, partial = true), 12)
        assertTrue(line.contains("найдено файлов: 40"), line)
        assertTrue(line.contains("показано 12"), line)
        assertTrue(line.contains("неполный"), line)
        assertEquals("найдено файлов: 2", planScanStatusLine(PlanScanResult(total = 2), 2))
        assertEquals("", planScanStatusLine(null, 0))
    }

    @Test
    fun `VALID the verdict decides what may be attached`() {
        val managed = planVerdictView(PlanInspection(path = "PLAN.md", managed = true, steps = 2, revision = 1, verdict = "VALID_MANAGED"))
        assertEquals("Готов к подключению", managed?.label)
        assertEquals(true, managed?.canAttach)
        assertEquals("Подключить", managed?.confirmLabel)
        assertEquals("", managed?.preview)

        val convertible = planVerdictView(
            PlanInspection(
                path = "docs/TODO.md",
                verdict = "CONVERTIBLE",
                preview = PlanPreview(
                    steps = listOf(PlanPreviewStep(id = "S-001")),
                    content = "taskbridge_plan: 1",
                ),
            ),
        )
        assertTrue(convertible?.preview?.contains("taskbridge_plan: 1") == true)

        val notAPlan = planVerdictView(PlanInspection(path = "README.md", verdict = "NOT_A_PLAN", problems = listOf("нет списка шагов")))
        assertEquals("Это не план", notAPlan?.label)
        assertEquals(false, notAPlan?.canAttach)
        assertEquals(listOf("нет списка шагов"), notAPlan?.reasons)

        assertEquals("Файл непригоден", planVerdictView(PlanInspection(verdict = "INVALID"))?.label)
        // Ответ сервера постарше без verdict не ломает экран.
        assertEquals("VALID_MANAGED", planVerdictView(PlanInspection(managed = true, steps = 1))?.verdict)
        assertNull(planVerdictView(null))
    }

    @Test
    fun `AI-02 the AI answer is advice with its model named`() {
        val review = planAiReviewView(
            PlanAiReview(
                ai = PlanAiVerdict(verdict = "NOT_PLAN", reasons = listOf("нет критериев выполнения")),
                structural = PlanAiStructural(verdict = "VALID_MANAGED"),
                model = PlanAiModel(provider = "openai", id = "gpt-4o", local = false),
                truncated = true,
            )
        )
        assertTrue(review?.text?.contains("модель считает, что это не план") == true)
        assertTrue(review?.text?.contains("нет критериев выполнения") == true)
        assertTrue(review?.text?.contains("облачный провайдер") == true)
        assertTrue(review?.text?.contains("только начало файла") == true)
        assertEquals("VALID_MANAGED", review?.structural)
        val local = planAiReviewView(PlanAiReview(ai = PlanAiVerdict(verdict = "PLAN"), model = PlanAiModel(provider = "llama", id = "qwen", local = true)))
        assertTrue(local?.text?.contains("локальная") == true)
        assertNull(planAiReviewView(null))
    }

    // --- FP-UX-05: компактная панель ---

    @Test
    fun `the scan area names its state instead of showing emptiness`() {
        val scan = PlanScanResult(files = listOf(PlanScanFile(name = "PLAN.md", path = "PLAN.md")), total = 1)
        assertEquals(PlanScanPhase.IDLE, planScanPhase(null, false, "", 0))
        assertEquals(PlanScanPhase.LOADING, planScanPhase(null, true, "", 0))
        assertEquals(PlanScanPhase.LOADING, planScanPhase(scan, true, "", 1))
        assertEquals(PlanScanPhase.ERROR, planScanPhase(null, false, "нет связи", 0))
        assertEquals(PlanScanPhase.EMPTY, planScanPhase(scan, false, "", 0))
        assertEquals(PlanScanPhase.READY, planScanPhase(scan, false, "", 1))
    }

    @Test
    fun `исправить формат предлагается только для не-плана`() {
        // Кнопка живёт там же, где нет подключения: NOT_A_PLAN и INVALID.
        val notAPlan = planVerdictView(PlanInspection(path = "README.md", verdict = "NOT_A_PLAN", problems = listOf("нет шагов")))
        val invalid = planVerdictView(PlanInspection(path = "BAD.md", verdict = "INVALID", problems = listOf("файл пуст")))
        val managed = planVerdictView(PlanInspection(path = "PLAN.md", managed = true, steps = 2, revision = 1, verdict = "VALID_MANAGED"))
        val convertible = planVerdictView(PlanInspection(path = "TODO.md", verdict = "CONVERTIBLE", preview = PlanPreview(steps = listOf(PlanPreviewStep(id = "S-001")))))
        assertEquals(false, notAPlan?.canAttach)
        assertEquals(false, invalid?.canAttach)
        assertEquals(true, managed?.canAttach)
        assertEquals(true, convertible?.canAttach)
    }
}
