package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.PlanStatus

// Follow Plan в интерфейсе KMP (FP-05C): те же решения и те же подписи, что в web
// (web/follow-plan-view.mjs). Решения живут здесь, а не в @Composable: ошибаются
// именно они — карточка пишет «выполняется», хотя цикл на паузе; выключение
// переключателя убивает ход вместо паузы; «Продолжить» доступна при конфликте
// ревизий. Проверяется без Compose — commonTest/FollowPlanTest.kt.

const val FOLLOW_PLAN_LABEL = "По плану"

val PLAN_STATE_LABELS: Map<String, String> = mapOf(
    "NOT_ATTACHED" to "план не подключён",
    "IDLE" to "готов к запуску",
    "RUNNING_STEP" to "выполняется шаг",
    "REVIEWING" to "проверка результата",
    "PAUSED_REVIEW" to "нужен разбор",
    "PAUSED" to "пауза",
    "COMPLETED" to "план завершён",
)

private val ACTIVE_STATES = setOf("RUNNING_STEP", "REVIEWING")

data class PlanAction(
    val id: String,
    val label: String,
    val enabled: Boolean,
    val hint: String,
)

data class PlanCardModel(
    val visible: Boolean,
    val headline: String,
    val goal: String,
    val findings: String,
    val conflict: String?,
    val error: String?,
    val actions: List<PlanAction>,
)

/** `PLAN.md • 3/7 • выполняется шаг S-004`. */
fun planHeadline(status: PlanStatus?): String {
    if (status == null || !status.attached) return "План не подключён"
    val progress = status.progress?.let { "${it.done}/${it.total}" } ?: "—"
    val state = PLAN_STATE_LABELS[status.state] ?: status.state
    val step = if (status.stepId != null && status.state in ACTIVE_STATES) " ${status.stepId}" else ""
    return "${status.path ?: "PLAN.md"} • $progress • $state$step"
}

/** Открытые находки, сначала блокирующие: в чат не выливается весь список. */
fun planFindingsLine(status: PlanStatus?): String {
    val open = status?.findings.orEmpty().filter { it.state == "OPEN" }
    if (open.isEmpty()) return ""
    val sorted = open.sortedBy { it.priority.orEmpty() }
    val first = sorted.first()
    val more = if (sorted.size > 1) " (+${sorted.size - 1})" else ""
    return "${first.priority ?: ""} ${first.summary ?: ""}".trim() + more
}

/**
 * Кнопки карточки. «Продолжить» — единственный запуск модели; «Пауза после шага» —
 * пауза на безопасной границе; «STOP сейчас» — отдельное действие.
 */
fun planActions(status: PlanStatus?, enabled: Boolean = true): List<PlanAction> {
    val state = status?.state ?: "NOT_ATTACHED"
    val attached = status?.attached == true
    val active = state in ACTIVE_STATES
    val blocked = state == "PAUSED_REVIEW" || status?.conflict == true || status?.fileError != null
    return listOf(
        PlanAction(
            id = "start",
            label = if (state == "COMPLETED") "Завершён" else if (attached) "Продолжить" else "Старт",
            enabled = enabled && attached && !active && state != "COMPLETED" && status?.conflict != true && status?.fileError == null,
            hint = when {
                !attached -> "Сначала подключите файл плана"
                active -> "Шаг уже выполняется"
                else -> "Отправить следующий шаг"
            },
        ),
        PlanAction("pause", "Пауза после шага", enabled && active, if (active) "Текущий шаг доиграет, следующий не будет отправлен" else "Пауза возможна только во время шага"),
        PlanAction("stop", "STOP сейчас", enabled && (active || state == "PAUSED_REVIEW"), "Остановить ход и оставить план на разбор"),
        PlanAction("open", "Открыть план", attached, status?.path ?: "Файл плана не подключён"),
        PlanAction("reconcile", "Принять файл", enabled && attached && blocked, "Принять версию файла с диска и снять конфликт"),
        PlanAction("edit", "Изменить план", enabled && attached, "Править файл плана в проекте"),
    )
}

fun planCardModel(status: PlanStatus?, enabled: Boolean = true): PlanCardModel {
    if (status == null || !status.attached) {
        return PlanCardModel(false, "План не подключён", "", "", null, null, emptyList())
    }
    val conflict = if (status.conflict) "Файл плана изменён снаружи: примите его версию или верните свою" else null
    return PlanCardModel(
        visible = true,
        headline = planHeadline(status),
        goal = status.goal.orEmpty(),
        findings = planFindingsLine(status),
        conflict = conflict,
        error = status.fileError?.message,
        actions = planActions(status, enabled),
    )
}

/** Выключение переключателя во время шага означает ПАУЗУ, а не STOP. */
fun planToggleOffAction(status: PlanStatus?): String =
    if (status?.state in ACTIVE_STATES) "pause" else "none"

/** Первое включение: путь к файлу плана внутри проекта. */
fun planPathProblem(value: String): String? {
    val text = value.trim()
    if (text.isEmpty()) return "Укажите путь к файлу плана, например docs/PLAN.md"
    if (text.startsWith("/") || text.startsWith("\\") || (text.length > 1 && text[1] == ':')) {
        return "Путь должен быть относительным, внутри проекта"
    }
    if (!text.lowercase().endsWith(".md")) return "План — это Markdown-файл (*.md)"
    return null
}
