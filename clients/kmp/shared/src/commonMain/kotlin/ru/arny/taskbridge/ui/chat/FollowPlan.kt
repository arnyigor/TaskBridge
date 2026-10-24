package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.ApiError
import ru.arny.taskbridge.core.api.ApiException
import ru.arny.taskbridge.core.api.PlanAiReview
import ru.arny.taskbridge.core.api.PlanInspection
import ru.arny.taskbridge.core.api.PlanScanResult
import ru.arny.taskbridge.core.api.PlanStatus
import ru.arny.taskbridge.core.api.WorkspaceFileEntry

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
            // A finished file has nothing to start: 2/2 DONE must not offer it.
            enabled = enabled && status?.enabled != false && attached && !active && state == "IDLE" && status?.file?.open != 0
                && status?.conflict != true && status?.fileError == null,
            hint = when {
                !attached -> "Сначала подключите файл плана"
                active -> "Шаг уже выполняется"
                else -> "Отправить следующий шаг"
            },
        ),
        PlanAction("resume", "Продолжить", enabled && status?.enabled != false && attached && state == "PAUSED" && !blocked, "Продолжить после паузы"),
        PlanAction("pause", "Пауза после шага", enabled && active, if (active) "Текущий шаг доиграет, следующий не будет отправлен" else "Пауза возможна только во время шага"),
        PlanAction("stop", "STOP сейчас", enabled && (active || state == "PAUSED_REVIEW"), "Остановить ход и оставить план на разбор"),
        PlanAction("open", "Открыть план", attached, status?.path ?: "Файл плана не подключён"),
        PlanAction("reconcile", "Принять файл", enabled && attached && !active && blocked, "Принять версию файла с диска и снять конфликт"),
        PlanAction("edit", "Изменить план", enabled && attached && !active, "Править файл плана в проекте"),
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

/**
 * Планы проекта для выбора: путь не набирают по памяти. Список дополняет ручной
 * ввод, а не заменяет его — файла может не быть в выдаче (глубокая папка, лимит).
 */
fun planFileChoices(entries: List<WorkspaceFileEntry>?, limit: Int = 200): List<WorkspaceFileEntry> =
    entries.orEmpty()
        .filter { it.isFile }
        .filter { it.path.lowercase().endsWith(".md") }
        .sortedBy { it.path }
        .take(limit)

/**
 * Переключатель показывает и выключенный на сервере режим: спрятанная функция
 * выглядит как «её не сделали» — с этого началась приёмка на телефоне 2026-10-23.
 */
fun planToggleEnabled(status: PlanStatus?): Boolean = status?.enabled == true

fun planToggleHint(status: PlanStatus?): String? =
    if (status != null && !planToggleEnabled(status)) "режим выключен на сервере" else null

/**
 * Что показывает сама иконка: карточки в чате больше нет, состояние кодируется
 * цветом, подробности — в диалоге (чат не должен занимать место под планом).
 */
enum class PlanIconState { OFF, IDLE, RUNNING, ATTENTION, COMPLETED }

fun planIconState(status: PlanStatus?): PlanIconState {
    if (status?.attached != true) return PlanIconState.OFF
    if (status.conflict || status.fileError != null) return PlanIconState.ATTENTION
    return when (status.state) {
        "RUNNING_STEP", "REVIEWING" -> PlanIconState.RUNNING
        "PAUSED", "PAUSED_REVIEW" -> PlanIconState.ATTENTION
        "COMPLETED" -> PlanIconState.COMPLETED
        else -> PlanIconState.IDLE
    }
}

/** Одна главная кнопка на состояние (UI-02 §6). */
data class PlanPrimaryAction(val id: String, val label: String)

fun planPrimaryAction(status: PlanStatus?): PlanPrimaryAction {
    if (status?.conflict == true) return PlanPrimaryAction("reconcile", "Обновить и сверить")
    // FP-UX-04A: стартовое состояние предлагает поиск по проекту первым; системный
    // выбор файла остаётся вторым и никуда не исчез.
    if (status?.attached != true) return PlanPrimaryAction("scan", "Сканировать проект")
    return when (status.state) {
        "IDLE" -> PlanPrimaryAction("start", "Начать выполнение")
        "RUNNING_STEP", "REVIEWING" -> PlanPrimaryAction("pause", "Пауза после шага")
        "PAUSED" -> PlanPrimaryAction("resume", "Продолжить")
        "PAUSED_REVIEW" -> PlanPrimaryAction("reconcile", "Разобрать результат")
        "COMPLETED" -> PlanPrimaryAction("open", "Открыть результат")
        else -> PlanPrimaryAction("refresh", "Проверить состояние")
    }
}

/** Строка состояния: статус, ревизия, шаги, цикл, шаг, стадия — словами, не цветом. */
fun planMetaLine(status: PlanStatus?): String {
    if (status?.attached != true) return ""
    val parts = mutableListOf<String>()
    parts += PLAN_STATE_LABELS[status.state] ?: status.state
    status.revision?.let { parts += "revision $it" }
    status.progress?.let { parts += "шагов ${it.done}/${it.total}" }
    status.cycleNumber?.let { parts += "цикл $it" }
    status.stepId?.let { parts += "шаг $it" }
    // Стадия сессии важна только пока план её ведёт: у idle-плана «ответ идёт»
    // (чужой ход той же сессии) читается как неправда.
    if (status.state == "RUNNING_STEP" || status.state == "REVIEWING") {
        status.stage?.let { parts += (PLAN_STAGE_LABELS[it] ?: it) }
    }
    return parts.joinToString(" • ")
}

val PLAN_STAGE_LABELS: Map<String, String> = mapOf(
    "RUNNING" to "Pi работает",
    "DISPATCHING" to "Pi работает",
    "ACKED" to "запрос принят",
    "PROGRESS" to "ответ идёт",
    "SETTLED" to "ход завершён",
    "SUCCEEDED" to "готово",
    "FAILED" to "ошибка хода",
    "CANCELLED" to "отменено",
)

data class PlanCurrentStep(val id: String, val title: String, val status: String, val result: String)

fun planCurrentStep(status: PlanStatus?): PlanCurrentStep? {
    val steps = status?.steps.orEmpty()
    val current = steps.firstOrNull { it.id == status?.stepId }
        ?: steps.firstOrNull { it.status == "IN_PROGRESS" || it.status == "BLOCKED" }
        ?: steps.firstOrNull { it.status == "TODO" }
        ?: steps.lastOrNull()
        ?: return null
    return PlanCurrentStep(current.id, current.title.orEmpty(), current.status, current.result.orEmpty())
}

/** Ошибка — словами и с лечением, а не общее «не удалось выполнить действие». */
fun planErrorText(code: String?, message: String?): String {
    val detail = message.orEmpty().replace(Regex("^[A-Z_]+:[ ]*"), "")
    return when (code) {
        "PLAN_INVALID" -> "Файл не соответствует формату плана. $detail".trim()
        "PLAN_REVISION_CONFLICT" -> "Файл плана изменён вне TaskBridge: сверьте версии и примите файл с диска. $detail".trim()
        "PLAN_UNKNOWN_OUTCOME" -> "Неизвестно, чем закончился прошлый ход: автоматический повтор запрещён. Проверьте состояние. $detail".trim()
        "PLAN_BUDGET_EXCEEDED" -> "Достигнут лимит циклов или времени — нужно ваше решение. $detail".trim()
        "FOLLOW_PLAN_DISABLED" -> "Режим «По плану» выключен в конфигурации сервера (followPlan.enabled)."
        "PLAN_BLOCKED" -> "Выполнение остановлено: ${detail.ifBlank { "шаг заблокирован" }}"
        "PLAN_FILE_EXISTS" -> "В проекте уже есть такой файл с другим содержимым: подтвердите перезапись. $detail".trim()
        "PLAN_ALREADY_ATTACHED" -> detail.ifBlank {
            "Уже подключён другой план. Откройте его панель и отключите, если нужно заменить."
        }.trim()
        "PLAN_NOT_ATTACHED" -> "План не подключён. $detail".trim()
        else -> detail.ifBlank { "Действие не выполнено." }
    }
}

/**
 * Код ошибки из ответа сервера, насколько его сохраняет клиент: 409 приходит с
 * кодом (PLAN_REVISION_CONFLICT/PLAN_FILE_EXISTS/…), для остальных остаётся
 * серверная фраза — её и показываем, а не общее «не удалось».
 */
fun planErrorCode(error: ApiException): String? = when (val api = error.error) {
    is ApiError.Busy -> api.code
    is ApiError.Forbidden -> api.code
    else -> null
}

fun planErrorText(error: ApiException): String =
    planErrorText(planErrorCode(error), error.error.message)

/**
 * Ошибки ИИ-проверки не должны звучать как ошибки плана: «модель недоступна»
 * оставляет возможность подключить валидный файл обычным путём (FP-UX-04E).
 */
fun planAiErrorText(error: ApiException): String = when (planErrorCode(error)) {
    "AI_RATE_LIMITED" -> error.error.message.ifBlank { "Проверка ИИ — не чаще трёх раз в минуту." }
    "AI_UNAVAILABLE" -> error.error.message.ifBlank { "Модель недоступна — обычная проверка формата работает без неё." }
    else -> planErrorText(error)
}

fun planInspectionText(inspection: PlanInspection?): String {
    if (inspection == null) return ""
    if (inspection.managed) return "Управляемый план: ${inspection.steps} шаг(ов), revision ${inspection.revision ?: 0}."
    return "Обычный Markdown: будет импортировано шагов — ${inspection.preview?.steps?.size ?: 0}. Файл не изменяется до подтверждения."
}

fun planIconTitle(status: PlanStatus?): String = when (planIconState(status)) {
    PlanIconState.OFF -> "По плану: выбрать файл плана"
    PlanIconState.IDLE -> "По плану: готов к запуску"
    PlanIconState.RUNNING -> "По плану: шаг выполняется"
    PlanIconState.ATTENTION -> "По плану: нужен разбор"
    PlanIconState.COMPLETED -> "По плану: план завершён"
}

/**
 * Планы проекта по папкам: на телефоне список путей без папок не отвечает на
 * вопрос «какой файл выбрать». Корень проекта идёт первым, дальше — по алфавиту.
 */
data class PlanFileGroup(val folder: String, val files: List<WorkspaceFileEntry>)

fun planFileGroups(entries: List<WorkspaceFileEntry>?): List<PlanFileGroup> =
    planFileChoices(entries)
        .groupBy { it.path.substringBeforeLast('/', "") }
        .map { (folder, files) -> PlanFileGroup(folder, files) }
        .sortedWith(compareBy({ it.folder.isNotEmpty() }, { it.folder }))

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

// --- FP-UX-04: сканирование, вердикт и ИИ -----------------------------------

val PLAN_VERDICT_LABELS: Map<String, String> = mapOf(
    "VALID_MANAGED" to "Готов к подключению",
    "CONVERTIBLE" to "Требует преобразования",
    "NOT_A_PLAN" to "Это не план",
    "INVALID" to "Файл непригоден",
)

/** Подписи предварительной догадки в списке найденных файлов. */
val PLAN_SCAN_HINTS: Map<String, String> = mapOf(
    "VALID_MANAGED" to "управляемый план",
    "CONVERTIBLE" to "нужен импорт",
)

data class PlanScanRow(
    val path: String,
    val name: String,
    val folder: String,
    val hint: String,
)

/**
 * Строки списка найденного. Фильтр по имени и пути считается на клиенте по уже
 * полученному результату: каждое нажатие клавиши не должно быть новым обходом
 * проекта на сервере.
 */
fun planScanRows(result: PlanScanResult?, query: String = "", limit: Int = 200): List<PlanScanRow> {
    val files = result?.files.orEmpty()
    val needle = query.trim().lowercase()
    val shown = if (needle.isEmpty()) files else files.filter {
        "${it.path} ${it.name}".lowercase().contains(needle)
    }
    return shown.take(limit).map { file ->
        PlanScanRow(
            path = file.path,
            name = file.name.ifBlank { file.path.substringAfterLast('/') },
            folder = file.path.substringBeforeLast('/', ""),
            hint = file.classification?.let { PLAN_SCAN_HINTS[it] } ?: "",
        )
    }
}

/** «найдено файлов: 40 • показано 12 • результат неполный». */
fun planScanStatusLine(result: PlanScanResult?, shownCount: Int): String {
    if (result == null) return ""
    val total = if (result.total > 0) result.total else result.files.size
    val parts = mutableListOf("найдено файлов: $total")
    if (shownCount != total) parts += "показано $shownCount"
    if (result.partial) parts += "результат неполный: достигнут лимит глубины, количества или времени"
    return parts.joinToString(" • ")
}

/** Пустое состояние: «не сканировали» — не то же, что «ничего не найдено». */
fun planScanEmptyText(result: PlanScanResult?, query: String = ""): String {
    if (result == null) return "Файлы проекта не сканировались."
    if (result.files.isEmpty()) return "В проекте не найдено ни одного Markdown-файла (.md или .markdown)."
    return "По запросу «${query.trim()}» ничего не найдено — измените поиск или повторите сканирование."
}

data class PlanVerdictView(
    val verdict: String,
    val label: String,
    val hint: String,
    val reasons: List<String>,
    val steps: Int,
    /** Подключать можно только то, что прошло структурную проверку. */
    val canAttach: Boolean,
    val confirmLabel: String,
    /** Предпросмотр будущего управляемого файла: показывается, но не пишется. */
    val preview: String,
)

fun planVerdictView(inspection: PlanInspection?): PlanVerdictView? {
    if (inspection == null) return null
    val verdict = inspection.verdict.ifBlank {
        when {
            inspection.managed -> "VALID_MANAGED"
            inspection.preview != null -> "CONVERTIBLE"
            else -> "NOT_A_PLAN"
        }
    }
    val reasons = (inspection.problems + inspection.preview?.problems.orEmpty()).filter { it.isNotBlank() }.take(4)
    val steps = if (inspection.managed) inspection.steps else inspection.preview?.steps?.size ?: 0
    return PlanVerdictView(
        verdict = verdict,
        label = PLAN_VERDICT_LABELS[verdict] ?: verdict,
        hint = inspection.reason.orEmpty(),
        reasons = reasons,
        steps = steps,
        canAttach = verdict == "VALID_MANAGED" || verdict == "CONVERTIBLE",
        confirmLabel = when {
            verdict == "CONVERTIBLE" -> "Импортировать и подключить"
            inspection.replaces != null -> "Заменить план"
            else -> "Подключить"
        },
        preview = if (verdict == "CONVERTIBLE") inspection.preview?.content.orEmpty() else "",
    )
}

data class PlanAiReviewView(val verdict: String, val text: String, val structural: String?)

/**
 * Совет модели словами и с названием модели: куда ушёл текст файла — часть ответа,
 * а не мелкий шрифт. Структурный вердикт сервера показывается рядом и остаётся
 * главным: модель его не заменяет.
 */
fun planAiReviewView(review: PlanAiReview?): PlanAiReviewView? {
    if (review == null) return null
    val verdict = review.ai?.verdict ?: "UNCLEAR"
    val label = when (verdict) {
        "PLAN" -> "модель считает, что это план"
        "NOT_PLAN" -> "модель считает, что это не план"
        else -> "модель не уверена"
    }
    val lines = mutableListOf(label)
    review.ai?.reasons.orEmpty().filter { it.isNotBlank() }.forEach { lines += "— $it" }
    val model = review.model
    if (model?.id != null) {
        val where = if (model.local) "локальная, текст не покидал машину" else "облачный провайдер: текст ушёл наружу"
        lines += "Спрошена модель ${model.provider?.let { "$it/" } ?: ""}${model.id} ($where)"
    }
    if (review.truncated) lines += "в модель ушло только начало файла"
    return PlanAiReviewView(verdict, lines.joinToString("\n"), review.structural?.verdict)
}
