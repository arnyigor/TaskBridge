package ru.arny.taskbridge.core.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// The HTTP contract of TaskBridge as the client reads it (docs/api-contract.md).
// The server may add fields at any time, so every class tolerates unknown keys
// and missing ones; statuses and event types stay strings with typed helpers,
// so a value this client does not know yet is carried, not rejected.

val TaskBridgeJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
    isLenient = true
}

@Serializable
data class ApiInfo(
    val name: String? = null,
    val apiVersion: Int = 0,
    val storeId: String? = null,
    val bootId: String? = null,
    val pi: PiInfo? = null,
    val warnings: List<ApiWarning> = emptyList(),
    val modelBusy: Boolean? = null,
    val modelReady: Boolean? = null,
    val addresses: List<ApiAddress> = emptyList(),
    val fileLimits: FileLimits? = null,
    val providerStatuses: Map<String, ProviderStatus> = emptyMap(),
    val scheduler: SchedulerInfo? = null,
    val engine: LocalEngineInfo? = null,
    val local: LocalRuntimeInfo? = null,
    /** RAM/CPU/GPU машины — то, по чему видно, что модель читается в память. */
    val system: SystemMetrics? = null,
)

@Serializable
data class LocalEngineInfo(
    val configured: Boolean = false,
    val reachable: Boolean = false,
    val state: String? = null,
    val model: String? = null,
    val name: String? = null,
    val contextWindow: Long? = null,
    val loaded: List<String> = emptyList(),
    val baseUrl: String? = null,
    val autoDetected: Boolean = false,
    val metrics: LocalModelMetrics? = null,
)

@Serializable
data class LocalRuntimeInfo(
    val enabled: Boolean = false,
    val mode: String? = null,
    val state: String? = null,
    val pid: Long? = null,
    val baseUrl: String? = null,
    val provider: String? = null,
    val reachable: Boolean = false,
    val loaded: List<String> = emptyList(),
    val loading: List<String> = emptyList(),
    val error: String? = null,
    /**
     * Все локальные модели одним списком: пресеты llama.cpp (роутер) и
     * настроенные внешние серверы вроде Strata ([LocalModelEntry.external]).
     * Состояние берётся отсюда, `loaded` знает только про роутер.
     */
    val models: List<LocalModelEntry> = emptyList(),
    /**
     * Скрытые строки (провайдеры/модели найденных автоматически серверов): они не в
     * `models`, но их можно вернуть — клиент показывает их отдельным блоком.
     */
    val hidden: List<String> = emptyList(),
)

@Serializable
data class LocalModelEntry(
    val id: String,
    val name: String? = null,
    /** Провайдер Pi для внешних серверов (у роутера — null, там общий provider). */
    val provider: String? = null,
    val status: String? = null,
    /**
     * Доля загрузки весов 0..1, пока [status] == "loading": llama.cpp отдаёт
     * сцены (stages) с прогрессом текущей, сервер сворачивает их в одно число
     * (то же, чем живут события LOCAL_MODEL_PROGRESS). `null` — прогресса нет:
     * внешний сервер поднимается целиком, порциями движок не отчитывается.
     */
    val loadRatio: Double? = null,
    val external: Boolean = false,
    val contextWindow: Long? = null,
    /**
     * Размер контекста этой модели можно менять отсюда: он лежит в конфиге
     * движка (`--max-context` файла, из которого внешний сервер стартует
     * модель), а не в самой модели. У пресетов роутера llama.cpp контекст
     * задаёт `ctx-size` в `models.ini`, и сервер помечает их `false` —
     * показываем число, но не даём его править.
     */
    val contextEditable: Boolean = false,
    /**
     * Есть ли на диске файлы, из которых сервер поднимает модель. `false` — веса
     * удалили: тогда «Загрузить» не сработает никогда, и строка обязана это сказать.
     * `null` — конфиг сервера не про файлы: судить нечем, интерфейс молчит.
     */
    val filesPresent: Boolean? = null,
    /** Первый отсутствующий путь из конфига — что именно искать. */
    val missingFile: String? = null,
    /**
     * Запись есть в конфиге TaskBridge, поэтому её можно убрать из списка. Строки, найденные в Pi
     * (`models.json`), принадлежат Pi — TaskBridge их не удаляет. У пресета роутера конфиг — его
     * секция в models.ini: такая строка тоже убирается, но только вместе с секцией.
     */
    val removable: Boolean = false,
    /**
     * Строку можно убрать из списка TaskBridge — но только скрыть: она найдена автоматически
     * (провайдер Pi + каталог установки), и удалять её неоткуда. Отменяется через [hidden].
     */
    val hideable: Boolean = false,
    /**
     * Наличие mmproj-проектора у пресета роутера (из его секции models.ini): оно и
     * делает модель vision. `null`-поведения нет — у внешних серверов и строк из Pi
     * vision задаётся их собственным конфигом, а не models.ini.
     */
    val vision: Boolean = false,
    /**
     * Vision этой строки правится отсюда: секция пресета есть в `models.ini` роутера.
     * Флаг нужен клиенту, чтобы показать переключатель, а не выдумывать его у строки,
     * чей конфиг принадлежит движку или Pi.
     */
    val visionEditable: Boolean = false,
    /** Живая телеметрия внешнего сервера (Strata /metrics): фаза, скорости, прогресс. */
    val metrics: LocalModelMetrics? = null,
    val phase: String? = null,
    val promptRead: Long? = null,
    val promptTotal: Long? = null,
)

/**
 * Ответ `POST /api/local/vision`: vision — свойство ПРЕСЕТА роутера (ключи
 * `mmproj`/`no-mmproj` его секции в `models.ini`), поэтому ответ описывает
 * правку записи, а не статус — как у контекста.
 */
@Serializable
data class LocalVisionChange(
    val provider: String? = null,
    val model: String? = null,
    val file: String? = null,
    val vision: Boolean = false,
    val previous: Boolean? = null,
    /**
     * Путь АКТИВНОГО проектора: у включённого vision — он, у выключенного — null
     * (путь остаётся в файле закомментированной строкой `; mmproj = …`, поэтому
     * включение обратно не ищет файл заново).
     */
    val mmproj: String? = null,
    val changed: Boolean = false,
    /** Роутер сейчас отвечает: `models.ini` он читает при старте — нужен перезапуск. */
    val restartRequired: Boolean = false,
)

/**
 * Ответ `POST /api/local/context`: размер контекста — параметр ЗАГРУЗКИ внешней
 * локальной модели, поэтому сервер правит не сессию, а файл, из которого движок
 * стартует, и отчитывается: что было, что стало, нужна ли перезагрузка модели.
 */
@Serializable
data class LocalContextChange(
    val provider: String? = null,
    val model: String? = null,
    val file: String? = null,
    val context: Long? = null,
    val previous: Long? = null,
    val changed: Boolean = false,
    /** Резидентная часть KV из того же файла (`--kv-resident`): может быть больше нового контекста. */
    val kvResident: Long? = null,
    /** Сервер сейчас отвечает: новый контекст подхватят только следующая загрузка. */
    val restartRequired: Boolean = false,
)

/**
 * Машинная нагрузка из /api/info: ответ на «почему модель медленная и что
 * происходит с памятью». Единицы — как их отдаёт сервер, без догадок:
 * [SystemRam.used]/[SystemRam.total] в БАЙТАХ, GPU — в МБ.
 */
@Serializable
data class SystemMetrics(
    val sampledAt: String? = null,
    val cpu: SystemCpu? = null,
    val ram: SystemRam? = null,
    val gpu: List<SystemGpu>? = null,
)

@Serializable
data class SystemCpu(val load: Double? = null, val cores: Int? = null)

@Serializable
data class SystemRam(val used: Long? = null, val total: Long? = null, val ratio: Double? = null)

@Serializable
data class SystemGpu(
    val name: String? = null,
    val memoryUsedMb: Long? = null,
    val memoryTotalMb: Long? = null,
    val utilization: Double? = null,
    val powerDrawW: Double? = null,
    val powerLimitW: Double? = null,
    val temperatureC: Double? = null,
)

@Serializable
data class LocalModelMetrics(
    val available: Boolean = false,
    val reason: String? = null,
    val source: String? = null,
    val model: String? = null,
    val name: String? = null,
    val pp: Double? = null,
    val tg: Double? = null,
    val requestsProcessing: Double? = null,
    val requestsDeferred: Double? = null,
    val kvRatio: Double? = null,
    val contextWindow: Long? = null,
    val nTokensMax: Double? = null,
    /** Strata: что модель делает сейчас (idle/generating/…). */
    val state: String? = null,
    val busy: Boolean = false,
    /** Strata: например «reading the prompt» — по этому видно чтение промпта. */
    val phase: String? = null,
    /** Strata: прогресс чтения промпта — promptRead из promptTotal (0..1 в progress). */
    val promptRead: Long? = null,
    val promptTotal: Long? = null,
    val progress: Double? = null,
    val elapsedS: Double? = null,
    val generated: Long? = null,
    /**
     * Strata: почему PP нет — сейчас только "conversation-cache": промпт
     * последнего запроса пришёл из кеша беседы (движок его вспомнил, а не
     * прочитал), и скорость чтения по нему не измеряется.
     */
    val ppUnavailable: String? = null,
    /** Strata: размер промпта и доля, которую движок реально прочитал. */
    val promptTokens: Long? = null,
    val freshTokens: Long? = null,
)

@Serializable
data class SchedulerInfo(
    val activeTasks: Int = 0,
    val maxConcurrentSessions: Int = 1,
    /** 0 — своих ограничений нет: сколько сессий одной рабочей папки идёт сразу, решает выбранный лимит. */
    val maxSessionsPerDirectory: Int = 0,
    val queuedTasks: Int = 0,
    val providers: Map<String, ProviderSlots> = emptyMap(),
    val queueWaitMs: QueueWaitMetrics? = null,
)

@Serializable
data class ProviderSlots(val active: Int = 0, val limit: Int = 1, val cooldownUntil: String? = null)

@Serializable
data class QueueWaitMetrics(val currentMax: Long = 0, val average: Long = 0, val samples: Int = 0)

@Serializable
data class ProviderStatus(
    val provider: String? = null,
    val label: String? = null,
    val kind: String? = null,
    val available: Boolean = false,
    val reason: String? = null,
    val stale: Boolean = false,
    val asOf: String? = null,
    val credits: Double? = null,
    val endsAt: String? = null,
    val balance: ProviderBalance? = null,
    val rub: ProviderRubBalance? = null,
    val pace: ProviderPace? = null,
    val runway: ProviderRunway? = null,
    val subscription: ProviderSubscription? = null,
    val usage: ProviderUsage? = null,
    val limits: Map<String, ProviderLimit> = emptyMap(),
    val resetCredits: ProviderResetCredits? = null,
)

@Serializable data class ProviderBalance(val cny: Double? = null, val usd: Double? = null)
@Serializable data class ProviderRubBalance(val cny: Double? = null, val usd: Double? = null, val total: Double? = null)
@Serializable data class ProviderPace(
    val recentPerDay: Double? = null,
    val historyPerDay: Double? = null,
    val recentPerDayRub: Double? = null,
    val historyPerDayRub: Double? = null,
    val monthlyRub: Double? = null,
)
@Serializable data class ProviderRunway(val recentDays: Int? = null, val historyDays: Int? = null)
@Serializable data class ProviderSubscription(
    val plan: String? = null,
    val remaining: Double? = null,
    val total: Double? = null,
    val used: Double? = null,
    val remainingRatio: Double? = null,
    val windowSeconds: Double? = null,
    val periodDays: Double? = null,
    val priceRub: Double? = null,
    val rateLimitRequests: Double? = null,
    val rateLimitSeconds: Double? = null,
    val concurrentRequests: Double? = null,
)
@Serializable data class ProviderUsage(
    val firstSeenAt: String? = null,
    val windowStartAt: String? = null,
    val nextResetAt: String? = null,
    val projectedEmptyAt: String? = null,
    val perDay: Double? = null,
)
@Serializable data class ProviderLimit(
    val usedPercent: Double? = null,
    val remainingPercent: Double? = null,
    val windowSeconds: Double? = null,
    val resetAt: String? = null,
)
@Serializable data class ProviderResetCredits(
    val available: Int? = null,
    val total: Int? = null,
    val earned: Int? = null,
    val nextExpiresAt: String? = null,
)

@Serializable
data class McpStatus(
    val mode: String = "inherit",
    val configPath: String? = null,
    val activePath: String? = null,
    val exists: Boolean = false,
    val servers: List<McpServer> = emptyList(),
    val collisions: List<McpCollision> = emptyList(),
)

@Serializable data class McpCollision(val tool: String, val servers: List<String> = emptyList())
@Serializable data class McpHealth(val state: String, val latencyMs: Long? = null, val checkedAt: String? = null, val statusCode: Int? = null, val error: String? = null)

@Serializable
data class McpServer(
    val name: String,
    val url: String? = null,
    val command: String? = null,
    val args: List<String> = emptyList(),
    val transport: String? = null,
    val disabled: Boolean = false,
    val excludeTools: List<String> = emptyList(),
    val tools: List<McpTool> = emptyList(),
    val auth: String? = null,
    val scopes: List<String> = emptyList(),
    val health: McpHealth? = null,
)

@Serializable data class McpTool(val name: String, val description: String = "")

@Serializable
data class PiInfo(
    val version: String? = null,
    val supported: Boolean = false,
    val supportedRange: String? = null,
    val error: String? = null,
)

@Serializable
data class ApiWarning(val code: String? = null, val message: String? = null)

@Serializable
data class ApiAddress(val `interface`: String? = null, val ip: String? = null, val url: String? = null)

@Serializable
data class FileLimits(
    val count: Int = 10,
    val totalBytes: Long = 16L * 1024 * 1024,
    val uploadFileBytes: Long = 64L * 1024 * 1024,
    val uploadBytes: Long = 128L * 1024 * 1024,
)

@Serializable
data class AuthStatus(
    val authenticated: Boolean = false,
    val enabled: Boolean = false,
    val local: Boolean = false,
    val machine: Boolean = false,
    /** The server pairs devices with tokens (R1.2); a cookie-only client should pair again. */
    val deviceTokens: Boolean = false,
)

@Serializable
data class QuickAction(
    val id: String,
    val type: String,
    val title: String,
    val description: String = "",
    val insertText: String,
)

@Serializable
data class Project(
    val id: String,
    val name: String? = null,
    val path: String? = null,
    val useWorktree: Boolean = false,
) {
    val displayName: String get() = name?.takeIf { it.isNotBlank() } ?: id
}

/**
 * One row of the project dashboard (`GET /api/projects/overview`, MR-01).
 *
 * The server computes these from the project registry and the sessions, so they
 * are always in step with the session list; only [pinned] and [archived] are
 * stored (SQLite), which is why they survive a restart.
 */
@Serializable
data class ProjectSummary(
    val id: String,
    val name: String? = null,
    val path: String? = null,
    val useWorktree: Boolean = false,
    val pinned: Boolean = false,
    val archived: Boolean = false,
    val sessions: Int = 0,
    /** Sessions that are not finished (working now or waiting in the queue). */
    val working: Int = 0,
    /** Sessions that will not move without the operator: failed, or waiting for an answer. */
    val needsAttention: Int = 0,
    /** MR-02: work items of this project, and how many of them are still open. */
    val workItems: Int = 0,
    val activeWork: Int = 0,
    val lastActivityAt: String? = null,
) {
    val displayName: String get() = name?.takeIf { it.isNotBlank() } ?: id
}

@Serializable
data class ProjectOverviewTotals(
    val projects: Int = 0,
    val pinned: Int = 0,
    val archived: Int = 0,
    val sessions: Int = 0,
    val working: Int = 0,
    val needsAttention: Int = 0,
    val workItems: Int = 0,
    val activeWork: Int = 0,
)

/**
 * The dashboard answer. [unassignedSessions] is the count of sessions whose
 * project is not in the registry any more: removing a registration never deletes
 * its sessions, so the screen can say where they went instead of hiding them.
 */
@Serializable
data class ProjectOverview(
    val projects: List<ProjectSummary> = emptyList(),
    val unassignedSessions: Int = 0,
    val totals: ProjectOverviewTotals = ProjectOverviewTotals(),
)

/** Pinned/archived of one project; the server answers with the merged values. */
@Serializable
data class ProjectPreferences(
    val pinned: Boolean = false,
    val archived: Boolean = false,
    val updatedAt: String? = null,
)

/**
 * A work item (MR-02): the semantic state of the work — what we are trying to do,
 * the criteria of done, and where it stands. Deliberately not a container: no
 * prompt, no chat history, no diff, no tool output.
 */
@Serializable
data class WorkItem(
    val id: String,
    val projectId: String,
    val title: String,
    val goal: String? = null,
    /** BACKLOG, READY, IN_PROGRESS, BLOCKED, DONE, CANCELLED. */
    val status: String = "BACKLOG",
    val priority: Int? = null,
    val acceptanceCriteria: List<String> = emptyList(),
    val tags: List<String> = emptyList(),
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val completedAt: String? = null,
) {
    val open: Boolean get() = status != "DONE" && status != "CANCELLED"
}

/**
 * A session that did the work (MR-03). This is NOT a run: runs live inside one
 * session, while a work item groups sessions. [available] is false when the
 * session disappeared on another device — the link stays visible instead of
 * silently vanishing.
 */
@Serializable
data class WorkItemSession(
    val workItemId: String,
    val sessionId: String,
    /** implementation, investigation, review, verification, resume. */
    val relation: String = "implementation",
    val createdAt: String? = null,
    val available: Boolean = true,
    val status: String? = null,
    val title: String? = null,
    val prompt: String? = null,
    val projectId: String? = null,
    val updatedAt: String? = null,
    val events: Int = 0,
)

/** `GET /api/work-items/:id` adds the sessions to the item itself. */
@Serializable
data class WorkItemDetail(
    val id: String,
    val projectId: String,
    val title: String,
    val goal: String? = null,
    val status: String = "BACKLOG",
    val priority: Int? = null,
    val acceptanceCriteria: List<String> = emptyList(),
    val tags: List<String> = emptyList(),
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val completedAt: String? = null,
    val sessions: List<WorkItemSession> = emptyList(),
) {
    val open: Boolean get() = status != "DONE" && status != "CANCELLED"
}

/** `GET /api/work-items/:id/sessions` and `GET /api/tasks/:id/work-items`. */
@Serializable
data class WorkItemSessionList(val items: List<WorkItemSession> = emptyList())

/**
 * A run recipe (MR-05): HOW a recurring piece of work is done — the prompt
 * template, its parameters, the agent and model, the context profile, the
 * workspace strategy and the verification. WHEN it runs is a schedule (MR-06),
 * and the fact that it ran is the session it created.
 */
@Serializable
data class RunRecipe(
    val id: String,
    val projectId: String,
    val workItemId: String? = null,
    val name: String,
    val promptTemplate: String,
    val parameters: Map<String, RecipeParameter> = emptyMap(),
    val runtime: RecipeRuntime = RecipeRuntime(),
    val context: RecipeContext = RecipeContext(),
    val workspace: RecipeWorkspace = RecipeWorkspace(),
    val verification: RecipeVerification = RecipeVerification(),
    val limits: RecipeLimits = RecipeLimits(),
    val createdAt: String? = null,
    val updatedAt: String? = null,
) {
    /** The parameters a phone can offer: every one has a declared kind. */
    val orderedParameters: List<Pair<String, RecipeParameter>> get() = parameters.entries.map { it.key to it.value }.sortedBy { it.first }
}

/** string | enum | boolean | number; `values` is present for an enum only. */
@Serializable
data class RecipeParameter(
    val type: String = "string",
    val values: List<String> = emptyList(),
    val description: String? = null,
    /** Types differ per kind, so the default travels as text and is read by `type`. */
    val `default`: kotlinx.serialization.json.JsonElement? = null,
) {
    val defaultText: String?
        get() = when (`default`) {
            null -> null
            is kotlinx.serialization.json.JsonPrimitive -> `default`.content
            else -> null
        }

    val defaultBoolean: Boolean get() = (`default` as? kotlinx.serialization.json.JsonPrimitive)?.content?.toBooleanStrictOrNull() ?: false
    val defaultNumber: Double? get() = (`default` as? kotlinx.serialization.json.JsonPrimitive)?.content?.toDoubleOrNull()
}

@Serializable
data class RecipeRuntime(val id: String = "pi", val model: String? = null, val thinking: String? = null)

@Serializable
data class RecipeContext(
    val profile: String = "work-item",
    val includeMemory: Boolean = true,
    val includeRecap: Boolean = true,
    val includeGit: Boolean = true,
)

@Serializable
data class RecipeWorkspace(val strategy: String = "fresh-worktree", val baseRef: String? = null)

@Serializable
data class RecipeVerification(val required: Boolean = false, val command: String? = null)

@Serializable
data class RecipeLimits(val timeoutMinutes: Int? = null)

/** `GET /api/recipes`. */
@Serializable
data class RecipeList(val items: List<RunRecipe> = emptyList())

/**
 * What `POST /api/recipes/:id` sends. Every field is optional: an absent one keeps
 * its stored value, which is what makes the same type usable for create and patch.
 */
@Serializable
data class RecipeRequest(
    val projectId: String? = null,
    val workItemId: String? = null,
    val name: String? = null,
    val promptTemplate: String? = null,
    val parameters: Map<String, RecipeParameter>? = null,
    /**
     * A nested object is sent WHOLE and replaces the stored one; leaving it out keeps
     * it. It is nullable on purpose: a default-filled `RecipeRuntime()` would reset a
     * stored model and thinking level on a patch that only renamed the recipe.
     */
    val runtime: RecipeRuntime? = null,
    val context: RecipeContext? = null,
    val workspace: RecipeWorkspace? = null,
    val verification: RecipeVerification? = null,
    val limits: RecipeLimits? = null,
)

/** The rendered recipe of `POST /api/recipes/:id/run`: what the session will actually get. */
@Serializable
data class RenderedRecipe(
    val recipeId: String,
    val projectId: String,
    val workItemId: String? = null,
    val name: String,
    val prompt: String,
    val parameters: kotlinx.serialization.json.JsonObject = kotlinx.serialization.json.JsonObject(emptyMap()),
    val runtime: RecipeRuntime = RecipeRuntime(),
    val workspace: RecipeWorkspace = RecipeWorkspace(),
)

/** The invocation a run created — the session itself, not a second record of it. */
@Serializable
data class RecipeInvocation(
    val recipeId: String,
    val recipeName: String? = null,
    val trigger: String = "manual",
    val parameters: kotlinx.serialization.json.JsonObject = kotlinx.serialization.json.JsonObject(emptyMap()),
    val at: String? = null,
)

/**
 * Шаг C-B: снимок версионирован ([Task.snapshotSeq]); старый ответ не откатывает
 * «лицо» хода (статус, стадию, фазу, runtime) — см. комментарий у модели.
 */
@Suppress("unused")
fun mergeTaskSnapshot(previous: Task?, next: Task, appliedCursor: Long): Task {
    if (previous == null) return next
    val nextSeq = next.snapshotSeq
    // Сервер без версии (старая сборка) — прежнее поведение.
    if (nextSeq <= 0 || nextSeq >= appliedCursor) return next
    return next.copy(
        snapshotSeq = maxOf(previous.snapshotSeq, nextSeq),
        status = previous.status,
        current = previous.current,
        turnState = previous.turnState ?: next.turnState,
        runtime = previous.runtime ?: next.runtime,
    )
}

@Serializable
data class RecipeRunResult(
    val task: Task,
    val invocation: RecipeInvocation? = null,
    val rendered: RenderedRecipe,
)

/** `DELETE /api/recipes/:id` answers with the recipe it removed. */
@Serializable
data class RecipeDeleted(val ok: Boolean = true, val removed: RunRecipe)

/** The session's own view of the run that produced it. */
@Serializable
data class RecipeRunInfo(
    val recipeId: String,
    val recipeName: String? = null,
    val trigger: String = "manual",
    val at: String? = null,
)

/**
 * A schedule (MR-06): WHEN a recipe runs. The scheduler lives on the PC — a phone
 * that is off changes nothing about whether 09:00 happens.
 */
@Serializable
data class Schedule(
    val id: String,
    val recipeId: String,
    val enabled: Boolean = true,
    val spec: ScheduleSpec = ScheduleSpec(),
    /** SKIP | RUN_ONCE (default) | CATCH_UP — what to do about a moment missed while the machine was off. */
    val misfirePolicy: String = "RUN_ONCE",
    /** SKIP_IF_RUNNING (default) | QUEUE | PARALLEL | REPLACE. */
    val concurrencyPolicy: String = "SKIP_IF_RUNNING",
    /** action-required (default) | always | errors-only | never. */
    val notify: String = "action-required",
    /** pause: an approval the agent asks for waits for a human, as in a manual session. */
    val approvalMode: String = "pause",
    val parameters: kotlinx.serialization.json.JsonObject = kotlinx.serialization.json.JsonObject(emptyMap()),
    val nextRunAt: String? = null,
    val lastRunAt: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
)

/** daily (`at`), weekly (`weekday` + `at`) or interval (`everyMinutes`). */
@Serializable
data class ScheduleSpec(
    val kind: String = "daily",
    val at: String? = null,
    /** mon…sun; a number would need a convention nobody agrees on. */
    val weekday: String? = null,
    val everyMinutes: Int? = null,
)

/** What `POST`/`PATCH /api/schedules` sends: an absent field keeps its stored value. */
@Serializable
data class ScheduleRequest(
    val recipeId: String? = null,
    val enabled: Boolean? = null,
    val spec: ScheduleSpec? = null,
    val misfirePolicy: String? = null,
    val concurrencyPolicy: String? = null,
    val notify: String? = null,
    val approvalMode: String? = null,
    val parameters: kotlinx.serialization.json.JsonObject? = null,
)

@Serializable
data class ScheduleList(val items: List<Schedule> = emptyList())

@Serializable
data class ScheduleDeleted(val ok: Boolean = true, val removed: Schedule)

/**
 * One run of a recipe (MR-06). The hierarchy is schedule → invocation → session →
 * run(s): this record says WHEN it was due and HOW it ended, the session holds the
 * work itself.
 */
@Serializable
data class Invocation(
    val id: String,
    val recipeId: String,
    val scheduleId: String? = null,
    val trigger: String = "manual",
    val scheduledAt: String? = null,
    val startedAt: String? = null,
    val finishedAt: String? = null,
    /** RUNNING | SUCCEEDED | FAILED | SKIPPED. */
    val status: String = "RUNNING",
    val reason: String? = null,
    val misfire: Boolean = false,
    val parameters: kotlinx.serialization.json.JsonObject = kotlinx.serialization.json.JsonObject(emptyMap()),
    val sessionId: String? = null,
    val verification: String? = null,
    val workspaceRef: String? = null,
    val resultArtifact: String? = null,
) {
    val running: Boolean get() = status == "RUNNING"
}

@Serializable
data class InvocationList(val items: List<Invocation> = emptyList())

/** What one scheduler tick decided, for diagnostics and for the tests. */
@Serializable
data class SchedulerDecision(
    val scheduleId: String,
    val action: String,
    val invocationId: String? = null,
    val sessionId: String? = null,
    val scheduledAt: String? = null,
    val reason: String? = null,
    val missed: Int? = null,
)

@Serializable
data class SchedulerTickResult(
    val at: String,
    val decisions: List<SchedulerDecision> = emptyList(),
    val reconciled: List<String> = emptyList(),
)

/** A work item as seen from a session (the session's own view). */
@Serializable
data class WorkItemRef(
    val id: String,
    val projectId: String,
    val title: String,
    val status: String = "BACKLOG",
    val relation: String = "implementation",
)

/** `GET /api/tasks/:id/work-items`. */
@Serializable
data class WorkItemRefList(val items: List<WorkItemRef> = emptyList())

/** The answer to unlinking: `removed = false` means there was nothing to unlink. */
@Serializable
data class WorkItemUnlink(val removed: Boolean = false)

/** `DELETE /api/work-items/:id` answers with the item it removed. */
@Serializable
data class WorkItemDeleted(val ok: Boolean = true, val removed: WorkItem)

/** `GET /api/work-items`: newest first, filtered by the server. */
@Serializable
data class WorkItemList(val items: List<WorkItem> = emptyList())

/** What `POST`/`PATCH` send: an absent field keeps its stored value. */
@Serializable
data class WorkItemRequest(
    val projectId: String? = null,
    val title: String? = null,
    val goal: String? = null,
    val status: String? = null,
    val priority: Int? = null,
    val acceptanceCriteria: List<String>? = null,
    val tags: List<String>? = null,
    /**
     * A null field means «do not change it», so clearing the goal needs its own
     * flag — otherwise an empty goal would be unreachable from a client.
     */
    val clearGoal: Boolean = false,
)

/**
 * One page of a project's sessions (`GET /api/projects/:id/sessions`).
 *
 * [registered] is false for a project that was removed from the registry: the
 * sessions are still there, and the screen shows them rather than a 404.
 */
@Serializable
data class ProjectSessionsPage(
    val projectId: String? = null,
    val registered: Boolean = true,
    val items: List<Task> = emptyList(),
    val total: Int = 0,
    val offset: Int = 0,
    val limit: Int = 0,
    val endReached: Boolean = false,
)

/** Folders exposed by the server inside projectBrowser.roots. */
@Serializable
data class ProjectFolder(val name: String, val path: String)

/**
 * Инспектор памяти проекта (MR-10): что проект отдаёт агенту прямо сейчас.
 *
 * Только чтение: [write] — всегда `SAVE_DISABLED`, автозапись невозможна. [status]
 * бывает `available`, `unavailable` (нет каталога памяти) и `ambiguous` — тогда в
 * [warnings] сказано, какие проекты делят один каталог памяти, а поиск не делается.
 */
@Serializable
data class ProjectMemoryOverview(
    val provider: String? = null,
    val status: String? = null,
    val write: String? = null,
    val projectName: String? = null,
    val projectRoot: String? = null,
    val injectedAutomatically: Boolean = false,
    val entries: Int? = null,
    val approxTokens: Long? = null,
    /** Категории записей как их называет сама память (`constraint`, `architecture`, …). */
    val categories: Map<String, Int> = emptyMap(),
    val problems: List<String> = emptyList(),
    val warnings: List<String> = emptyList(),
    /** Заполняется только у поиска: null — обзор, "" — только что очищенное поле поиска. */
    val query: String? = null,
    /** Список записей приходит только с поиском: без `q` целиком его не отдают. */
    val hits: List<ProjectMemoryHit>? = null,
    /**
     * Этап M2: записи с метаданными использования (`useCount`/`lastUsedAt` из
     * индекса) — их видно без поиска, в самом обзоре.
     */
    val notes: List<ProjectMemoryNote> = emptyList(),
    /** Бюджет инъекции (`memory.indexBudgetTokens`/`globalBudgetTokens`) и признак переполнения. */
    val budget: ProjectMemoryBudget? = null,
    /** Состояние индекса памяти и сколько раз память использовалась. */
    val index: ProjectMemoryIndex? = null,
    /** Глобальные знания (`_global/`): сколько и на сколько токенов. */
    val global: ProjectMemoryGlobal? = null,
)

/** Одна запись памяти в обзоре: где лежит, что это и как часто помогала. */
@Serializable
data class ProjectMemoryNote(
    val source: String,
    val category: String? = null,
    val description: String? = null,
    val updatedAt: String? = null,
    val estimatedTokens: Int? = null,
    val useCount: Int = 0,
    val lastUsedAt: String? = null,
)

/** Бюджет памяти: сколько токенов разрешено проекту и глобальному скоупу. */
@Serializable
data class ProjectMemoryBudget(
    val indexTokens: Int? = null,
    val globalTokens: Int? = null,
    val approxTokens: Long? = null,
    /** Индекс проекта больше бюджета: в контекст уйдёт не всё. */
    val overBudget: Boolean = false,
)

/** Индекс памяти: кэш поиска, его состояние видно оператору. */
@Serializable
data class ProjectMemoryIndex(
    val available: Boolean = false,
    val notes: Int = 0,
    val uses: Int = 0,
    val lastUsedAt: String? = null,
)

/** Глобальные знания: общие для всех проектов, со своим мини-бюджетом. */
@Serializable
data class ProjectMemoryGlobal(
    val entries: Int = 0,
    val approxTokens: Int = 0,
)

/** Одна найденная запись. [source] — путь относительно папки проекта в памяти. */
@Serializable
data class ProjectMemoryHit(
    val source: String,
    val category: String? = null,
    val text: String = "",
)

@Serializable
data class ProjectFolderListing(
    val path: String? = null,
    val parent: String? = null,
    val entries: List<ProjectFolder> = emptyList(),
)

/** A file or folder inside the task workspace, addressed by a relative posix path —
 *  the same path an @-reference in the prompt resolves against. */
@Serializable
data class WorkspaceFileEntry(val name: String, val path: String, val isFile: Boolean = false)

@Serializable
data class WorkspaceFileListing(val path: String? = null, val entries: List<WorkspaceFileEntry> = emptyList())

@Serializable
data class ModelCost(
    val input: Double? = null,
    val output: Double? = null,
    val cacheRead: Double? = null,
    val cacheWrite: Double? = null,
)

@Serializable
data class ModelRef(
    val provider: String? = null,
    val id: String? = null,
    val name: String? = null,
    val contextWindow: Long? = null,
    val maxTokens: Long? = null,
    val reasoning: Boolean? = null,
    val images: Boolean? = null,
    val tools: Boolean? = null,
    val cost: ModelCost? = null,
    /**
     * Модель обслуживается этим компьютером: пресеты llama.cpp-роутера и
     * настроенные внешние серверы (Strata). Сервер вычисляет это по `localRuntime`
     * (провайдер роутера + externalServers), потому что у них разные Pi-провайдеры,
     * а машина одна: пикер показывает их одной группой.
     */
    val local: Boolean = false,
    /**
     * Уровни размышлений, которые принимает ИМЕННО эта модель — по её карте в
     * Pi (thinkingLevelMap). Общий список каталога относится к текущей модели
     * по умолчанию, поэтому для локальных моделей он неверен: Strata принимает
     * off/low/medium/high/xhigh, а «minimal» и «max» в её карте равны null.
     */
    val thinkingLevels: List<String> = emptyList(),
    /**
     * Уровень → значение, которое получит провайдер, только там, где они
     * различаются: у Strata «high» уходит в движок как «xhigh», «off» → «none».
     * Показывается в подписи, чтобы «High» не читалось как уровень высокий.
     */
    val thinkingMap: Map<String, String> = emptyMap(),
) {
    val label: String get() = name?.takeIf { it.isNotBlank() } ?: id ?: "—"
    val key: String get() = "${provider.orEmpty()}/${id.orEmpty()}"
}

@Serializable
data class ModelCatalog(
    val models: List<ModelRef> = emptyList(),
    val thinkingLevels: List<String> = emptyList(),
    val defaultModel: ModelRef? = null,
    val defaultThinkingLevel: String? = null,
    // Rolling TTFT history keyed by ModelRef.key ("provider/id"), local and cloud models alike.
    val latency: Map<String, ModelLatency> = emptyMap(),
)

/** Explicit one-token model probe; unlike [ModelLatency], it is never mixed into real-turn history. */
@Serializable
data class ModelProbeResult(
    val mode: String? = null,
    val ok: Boolean = false,
    val ms: Long? = null,
    val httpStatus: Int? = null,
    val models: Int? = null,
    val tokensUsed: Int? = null,
    val code: String? = null,
    val message: String? = null,
    val retryInMs: Long? = null,
)

@Serializable
data class ModelLatencySample(
    val ttftMs: Long? = null,
    val at: String? = null,
)

@Serializable
data class ModelLatency(
    val count: Int = 0,
    val avgMs: Long? = null,
    val p50Ms: Long? = null,
    val lastMs: Long? = null,
    val samples: List<ModelLatencySample> = emptyList(),
)

@Serializable
data class FileRef(
    val id: String? = null,
    val name: String? = null,
    val size: Long? = null,
    val mimeType: String? = null,
    val path: String? = null,
)

@Serializable
data class PendingPrompt(
    val id: String,
    val text: String = "",
    val mode: String? = null,
    val files: List<FileRef> = emptyList(),
    val commandId: String? = null,
    val clientId: String? = null,
)

@Serializable
data class Usage(
    val input: Long? = null,
    val output: Long? = null,
    val cacheRead: Long? = null,
    val cacheWrite: Long? = null,
    val totalTokens: Long? = null,
)

@Serializable
data class GenerationMetrics(
    val pp: Double? = null,
    val tg: Double? = null,
    val inputTokens: Long? = null,
    val outputTokens: Long? = null,
    val promptMs: Long? = null,
    val ms: Long? = null,
    val source: String? = null,
    val ppSource: String? = null,
    val tgSource: String? = null,
    val ppApproximate: Boolean = false,
)

@Serializable
data class SessionSpeeds(
    /** Ходов, за которые посчитаны скорости сессии. */
    val turns: Int = 0,
    /** Максимальный PP за сессию; null — ни один ход не дал числа. */
    val ppMax: Double? = null,
    val ppAvg: Double? = null,
    /** Средняя TG за сессию. */
    val tgAvg: Double? = null,
    /** Ходов, у которых вообще был PP / TG (кеш-попадания и ходы без вывода не считаются). */
    val ppTurns: Int = 0,
    val tgTurns: Int = 0,
)

@Serializable
data class CompactionInfo(
    val count: Int = 0,
    val last: CompactionLast? = null,
)

@Serializable
data class CompactionLast(
    val reason: String? = null,
    val tokensBefore: Long? = null,
    val estimatedTokensAfter: Long? = null,
    val summary: String? = null,
    val at: String? = null,
)

@Serializable
data class RuntimeInfo(val state: String? = null, val activity: String? = null, /** Epoch ms when the current compaction started; only present while activity == "compacting". */ val compactingSince: Long? = null)

/**
 * Почему сессия стоит, хотя Pi жив: провайдер не принял запрос и Pi ждёт повтора
 * (обычно HTTP 429 с `retry-after`).
 *
 * Без этих полей отказ провайдера неотличим от сломанного моста: событий модели
 * нет, статус RUNNING, активность streaming — оператор видел «работает» полтора
 * часа, пока провайдер держал `retry-after` в 1 ч 31 мин. Причина — своими
 * словами провайдера ([reason]), момент повтора — абсолютный ([retryAt]), чтобы
 * счётчик шёл на клиенте, а не по чужим секундам.
 */
@Serializable
data class ProviderWait(
    /** `rate-limit` (провайдер отказал по лимиту) или `retry` (сбой, Pi повторяет). */
    val kind: String? = null,
    val provider: String? = null,
    val model: String? = null,
    val httpStatus: Int? = null,
    val reason: String? = null,
    /** Сколько ждать от момента объявления, мс. */
    val waitMs: Long? = null,
    /** Момент, когда Pi повторит запрос (ISO). */
    val retryAt: String? = null,
    /** Когда это ожидание началось и когда о нём сообщили в последний раз. */
    val since: String? = null,
    val at: String? = null,
)

/**
 * Один источник контекста из `GET /api/tasks/:id/context`: откуда именно текст
 * попадает в запрос к модели (системный промпт, инструкции проекта, описания
 * навыков, объявления MCP-инструментов).
 *
 * [known] == false значит «источник есть, но его размер снаружи Pi не измеряется»
 * (базовые инструкции Pi, встроенные инструменты, память проекта): показывать
 * вместо размера ноль было бы враньём.
 */
@Serializable
data class ContextSource(
    val id: String,
    val label: String? = null,
    val detail: String? = null,
    val chars: Long? = null,
    val tokens: Long? = null,
    val known: Boolean = false,
    val count: Int? = null,
    val files: List<String> = emptyList(),
    val servers: List<String> = emptyList(),
)

/** Размер части окна модели, занятый под запрос (`get_session_stats` от Pi). */
@Serializable
data class ContextUsage(
    val tokens: Long? = null,
    val contextWindow: Long? = null,
    val percent: Double? = null,
    /** `pi` — числа пришли от запущенной сессии Pi; null — сессия не запущена. */
    val source: String? = null,
)

/** Настройки сжатия Pi, которые задают, когда начинается автосжатие. */
@Serializable
data class ContextCompaction(
    val auto: Boolean? = null,
    val reserveTokens: Long? = null,
    val keepRecentTokens: Long? = null,
    /** Окно модели минус reserveTokens — порог, после которого Pi сжимает сам. */
    val triggerAt: Long? = null,
    val fromProject: Boolean = false,
)

/** Сколько сообщений и токенов прошло через сессию (за всю её жизнь, не в окне). */
@Serializable
data class ContextConversation(
    val userMessages: Int? = null,
    val assistantMessages: Int? = null,
    val toolCalls: Int? = null,
    val messages: Int? = null,
    val tokens: Usage? = null,
    val cost: Double? = null,
)

/**
 * Ответ `GET /api/tasks/:id/context` и `POST /api/tasks/:id/context`.
 *
 * `totalTokens`, [conversation] и [unaccountedTokens] — числа самого Pi;
 * размеры [sources] — оценка (символы / 4). Остаток — то, чего в читаемых
 * файлах нет: история ветки, вложения, текст расширений.
 */
@Serializable
data class SessionContextReport(
    val taskId: String? = null,
    val model: ModelRef? = null,
    val contextWindow: Long? = null,
    val usage: ContextUsage? = null,
    val conversation: ContextConversation? = null,
    val totalTokens: Long? = null,
    val sources: List<ContextSource> = emptyList(),
    val measuredTokens: Long = 0,
    val unaccountedTokens: Long? = null,
    /**
     * Оценка источников больше того, что насчитал Pi. Тогда [unaccountedTokens]
     * равен нулю из-за переоценки, а не потому что истории нет: показывать
     * «остаток 0» в этом случае неверно.
     */
    val overestimated: Boolean = false,
    val limit: ContextLimit = ContextLimit(),
    val compaction: ContextCompaction? = null,
    val running: Boolean = false,
    val note: String? = null,
)

/** Лимит контекста сессии: настройка TaskBridge, а не Pi. `tokens == null` — без лимита. */
@Serializable
data class ContextLimit(
    val tokens: Long? = null,
    val exceeded: Boolean = false,
)

/** Шаг C-A: фаза и точка прогресса текущего хода (аддитивное поле снимка). */
@Serializable
data class TurnState(
    val phase: String? = null,
    val turn: Long? = null,
    val stage: String? = null,
    val lastProgressAt: String? = null,
    val silentMs: Long? = null,
)

@Serializable
data class Task(
    val id: String,
    val title: String? = null,
    val prompt: String? = null,
    val projectId: String? = null,
    val turnState: TurnState? = null,
    /** Шаг C-B: seq последнего события сессии на момент снимка (0 — старый сервер). */
    val snapshotSeq: Long = 0,
    val status: String = "QUEUED",
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val statusChangedAt: String? = null,
    val queueReason: String? = null,
    val current: String? = null,
    val error: String? = null,
    val errorCode: String? = null,
    val model: ModelRef? = null,
    val requestedModel: ModelRef? = null,
    val thinkingLevel: String? = null,
    val thinkingLevelActual: String? = null,
    val workspacePath: String? = null,
    val workspaceTrusted: Boolean = false,
    val pendingPrompts: List<PendingPrompt> = emptyList(),
    val files: List<FileRef> = emptyList(),
    val outputFiles: List<FileRef> = emptyList(),
    val lastUsage: Usage? = null,
    val metrics: GenerationMetrics? = null,
    /** Скорости всей сессии (макс./средний PP, средняя TG); null — ходов ещё не было. */
    val speeds: SessionSpeeds? = null,
    val compaction: CompactionInfo? = null,
    val autoCompactionEnabled: Boolean? = null,
    /** Лимит контекста сессии в токенах; null — без лимита (см. SessionContextReport). */
    val contextLimit: Long? = null,
    val sessionAvailable: Boolean? = null,
    val assistantText: String? = null,
    val thinkingText: String? = null,
    val retryable: Boolean? = null,
    val runtime: RuntimeInfo? = null,
    /** Заполнено, только пока провайдер держит ход: Pi объявил повтор и ждёт. */
    val providerWait: ProviderWait? = null,
    /** On-disk footprint of the session (task folder + Pi session + workspace), absent when the server did not compute it. */
    val sizeBytes: Long? = null,
) {
    val taskStatus: TaskStatus get() = TaskStatus.from(status)

    /** What a list shows: the title if the operator gave one, else the first line of the prompt. */
    val displayTitle: String
        get() = title?.takeIf { it.isNotBlank() }
            ?: prompt?.lineSequence()?.firstOrNull { it.isNotBlank() }?.trim()?.take(120)
            ?: "Сессия $id"
}

enum class TaskStatus(val active: Boolean, val terminal: Boolean) {
    QUEUED(true, false),
    PREPARING(true, false),
    PREFLIGHT(true, false),
    RUNNING(true, false),
    WAITING_USER(true, false),
    VERIFYING(true, false),
    CANCELLING(true, false),
    SUCCEEDED(false, true),
    FAILED(false, true),
    CANCELLED(false, true),
    UNKNOWN(false, false);

    companion object {
        fun from(value: String?): TaskStatus = entries.firstOrNull { it.name == value } ?: UNKNOWN
    }
}

@Serializable
data class TaskEvent(
    val taskId: String? = null,
    val seq: Long = 0,
    val at: String? = null,
    val type: String = "",
    val message: String? = null,
    val data: JsonObject = JsonObject(emptyMap()),
) {
    /** The raw Pi frame of a PI_EVENT. */
    val piFrame: JsonObject? get() = data["pi"] as? JsonObject

    fun string(key: String): String? = (data[key] as? JsonPrimitive)?.contentOrNull
}

/** GET /api/tasks/:id/events?tail= answers a window, not a bare list. */
@Serializable
data class EventWindow(val events: List<TaskEvent> = emptyList(), val reachedStart: Boolean = false)

@Serializable
data class CommandStatus(
    val commandId: String? = null,
    val status: String? = null,
    val done: Boolean = false,
    val clientId: String? = null,
)

@Serializable
data class Approval(
    val approvalId: String,
    val toolCallId: String? = null,
    val toolName: String? = null,
    val risk: String? = null,
    val detail: String? = null,
    val status: String? = null,
    val args: JsonElement? = null,
)

@Serializable
data class ToolOutput(
    val toolCallId: String? = null,
    val text: String = "",
    val bytes: Long = 0,
    val truncated: Boolean = false,
)

@Serializable
data class UploadResult(val token: String, val files: List<FileRef> = emptyList())

@Serializable
data class CreateTaskRequest(
    val projectId: String,
    val prompt: String,
    val title: String? = null,
    val model: ModelSelection? = null,
    val thinkingLevel: String? = null,
    val uploadToken: String? = null,
    val files: List<UploadedFileId>? = null,
    val commandId: String? = null,
    val clientId: String? = null,
)

/** A file already sent to /api/uploads, referenced by id (the server never trusts client names or sizes). */
@Serializable
data class UploadedFileId(val id: String)

@Serializable
data class ModelSelection(val provider: String?, val id: String)

@Serializable
data class MessageRequest(
    val text: String,
    val mode: String = "auto",
    val now: Boolean = false,
    val queue: Boolean = false,
    val uploadToken: String? = null,
    val files: List<UploadedFileId>? = null,
    val commandId: String? = null,
    val clientId: String? = null,
)

/** The id of Scratch: a session without a project. */
const val SCRATCH_PROJECT_ID = "__scratch__"

internal fun JsonElement?.stringOrNull(): String? = (this as? JsonPrimitive)?.contentOrNull

internal fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject

internal fun JsonElement.asObjectOrNull(): JsonObject? = runCatching { jsonObject }.getOrNull()

internal fun JsonElement.asStringOrNull(): String? = runCatching { jsonPrimitive.contentOrNull }.getOrNull()

// --- Hugging Face: поиск, варианты GGUF, загрузки (Local Model Library) ---

/** Строка поиска /api/hf/search. */
@Serializable
data class HfSearchResult(
    val repo: String,
    val author: String? = null,
    val downloads: Long = 0,
    val likes: Long = 0,
    val lastModified: String? = null,
    /** Gated/private репозиторий: скачать без токена на сервере не выйдет. */
    val gated: Boolean = false,
)

/** Один файл модели в дереве репозитория (размеры берёт сервер). */
@Serializable
data class HfFileRef(val path: String, val size: Long? = null)

/** Вариант модели: квант + все его файлы (у шардированных — части). */
@Serializable
data class HfVariant(
    val quant: String,
    val files: List<HfFileRef> = emptyList(),
    val totalBytes: Long = 0,
    /** Число частей шардированного файла (00001-of-N); null — файл один. */
    val shards: Int? = null,
    /** Неполный набор частей качать нельзя. */
    val complete: Boolean = true,
)

/** mmproj-проектор для vision-моделей; скачивается автоматически вместе с квантом. */
@Serializable
data class HfProjector(val path: String, val size: Long? = null, val quant: String? = null)

@Serializable
data class HfRepoInfo(
    val repo: String,
    /** Конкретная ревизия (commit sha) — она и попадёт в реестр библиотеки. */
    val revision: String,
    val variants: List<HfVariant> = emptyList(),
    val projectors: List<HfProjector> = emptyList(),
)

/** Задание загрузки из /api/hf/downloads. */
@Serializable
data class HfDownloadJob(
    val id: String,
    val repo: String,
    val revision: String? = null,
    val label: String? = null,
    val files: List<HfFileRef> = emptyList(),
    val totalBytes: Long = 0,
    val downloadedBytes: Long = 0,
    val state: String,
    val error: String? = null,
    /** Байт/с — только у активных заданий. */
    val speed: Double? = null,
    /** id записи библиотеки, вычисленный при старте загрузки: нужен кнопке «Прописать в Pi». */
    val libraryId: String? = null,
) {
    val active: Boolean get() = state in setOf("QUEUED", "DOWNLOADING", "VERIFYING")
    val resumable: Boolean get() = state in setOf("FAILED", "INTERRUPTED", "CANCELLED")
}

@Serializable
data class HfDownloads(val jobs: List<HfDownloadJob> = emptyList())

/** Сколько завершённых заданий убрано из списка загрузок. */
@Serializable
data class HfDownloadsClear(val removed: Int = 0)

/** Запись библиотеки установленных моделей (или standalone-файл после скана). */
@Serializable
data class LibraryEntry(
    val id: String,
    val name: String? = null,
    val quant: String? = null,
    val format: String? = null,
    val vision: Boolean = false,
    val files: List<HfFileRef> = emptyList(),
    /** Проверка наличия файлов на диске (свежая — по ?fresh=1). */
    val filesPresent: Boolean = true,
    /** Пресет в models.ini роутера, если модель уже «Прописана в Pi». */
    val preset: String? = null,
    val missingFiles: List<String> = emptyList(),
    val source: HfSource? = null,
)

@Serializable
data class HfSource(val type: String? = null, val repo: String? = null, val revision: String? = null)

@Serializable
data class LibraryStatus(
    val models: List<LibraryEntry> = emptyList(),
    val standalone: List<LibraryEntry> = emptyList(),
    val root: String? = null,
)

/** Результат «Прописать в Pi»: пресет в models.ini роутера llama.cpp. */
@Serializable
data class LibraryRegistration(
    val preset: String,
    val file: String,
    val changed: Boolean = false,
    /** Роутер сейчас жив: models.ini он читает при старте — нужен перезапуск. */
    val restartRequired: Boolean = false,
    val model: String? = null,
    val mmproj: String? = null,
)

/** Результат удаления модели из библиотеки: файлы, общие с другими записями (например vision-проектор), остаются. */
@Serializable
data class LibraryDeletion(
    val removed: List<String> = emptyList(),
    val kept: List<String> = emptyList(),
    val freedBytes: Long = 0,
    val presetRemoved: Boolean = false,
)

/** Один процесс машины с сервером: снапшот из /api/processes для панели «Процессы». */
@Serializable
data class ProcessEntry(
    val pid: Long,
    val name: String? = null,
    /** PID родителя из снапшота; null — ОС не сообщила (нужно для группировки по дереву). */
    val parentPid: Long? = null,
    /** Резидентная память в байтах; null — ОС её не сообщила (POSIX-список). */
    val memoryBytes: Long? = null,
    /** Момент старта процесса, ms epoch; null — ОС не сообщила. */
    val startedAt: Long? = null,
    val commandLine: String? = null,
)

/** Обёртка ответа GET /api/processes: сервер отдаёт {"processes":[...]} (null — ОС не ответила). */
@Serializable
data class ProcessList(
    val processes: List<ProcessEntry> = emptyList(),
)

@Serializable
data class GpuProcessEntry(
    val pid: Long,
    val name: String? = null,
    val memoryMb: Long? = null,
)

@Serializable
data class GpuProcessList(
    val processes: List<GpuProcessEntry>? = null,
)

/** Агрегированный снимок ресурсов из GET /api/system/resources (PROC-01). */
@Serializable
data class ResourceSnapshot(
    val ram: RamSnapshot? = null,
    /** null — nvidia-smi недоступен; null-поля карточки — «неизвестно», никогда не 0. */
    val gpu: GpuSummary? = null,
)

@Serializable
data class RamSnapshot(
    val totalBytes: Long? = null,
    val freeBytes: Long? = null,
    val usedBytes: Long? = null,
    val sampledAt: String? = null,
)

@Serializable
data class GpuSummary(
    val source: String? = null,
    val sampledAt: String? = null,
    val gpus: List<GpuCard> = emptyList(),
)

@Serializable
data class GpuCard(
    val name: String? = null,
    val vramTotalMb: Long? = null,
    val vramUsedMb: Long? = null,
    val vramFreeMb: Long? = null,
    val utilizationPercent: Long? = null,
)

/**
 * Pi-сессия на диске, найденная сервером (GET /api/native-sessions): единица импорта
 * в TaskBridge. `key` — непрозрачный sha256 от пути, клиент не имеет права присылать
 * путь сам; `existingTaskId` не null, если эта сессия уже импортирована.
 */
@Serializable
data class NativeSession(
    val key: String,
    val id: String? = null,
    val name: String? = null,
    val cwd: String? = null,
    /** ISO-время изменения файла сессии; null — сервер не сообщил. */
    val mtime: String? = null,
    val preview: String? = null,
    val existingTaskId: String? = null,
) {
    val displayName: String get() = name?.takeIf { it.isNotBlank() } ?: id ?: key.take(8)
}

/** Сессии одного проекта; `suggestion` — свежая неимпортированная, которую сервер предлагает первой. */
@Serializable
data class NativeSessionGroup(
    val id: String,
    val name: String? = null,
    val path: String? = null,
    val sessions: List<NativeSession> = emptyList(),
    val suggestion: NativeSessionSuggestion? = null,
) {
    val displayName: String get() = name?.takeIf { it.isNotBlank() } ?: id
}

@Serializable
data class NativeSessionSuggestion(
    val key: String,
    val name: String? = null,
    val mtime: String? = null,
    val preview: String? = null,
)

/** Предпросмотр перед импортом (GET /api/native-sessions/preview): что внутри сессии. */
@Serializable
data class NativeSessionPreview(
    val projectId: String,
    val key: String,
    val projectPath: String? = null,
    val id: String? = null,
    val name: String? = null,
    val mtime: String? = null,
    val entryCount: Int = 0,
    val messageCount: Int = 0,
    val model: NativeSessionModel? = null,
    val thinkingLevel: String? = null,
    val tokens: Long? = null,
    val lastUser: String? = null,
    val lastAssistant: String? = null,
    val existingTaskId: String? = null,
)

@Serializable
data class NativeSessionModel(val provider: String? = null, val id: String? = null)

/**
 * Как импортировать: `clone` копирует JSONL в папку задачи (терминальная сессия Pi
 * остаётся живой), `take-over` забирает оригинал и требует явного подтверждения,
 * что сессия в терминале закрыта.
 */
enum class NativeImportMode(val wire: String, val label: String) {
    Clone("clone", "Копия"),
    TakeOver("take-over", "Забрать оригинал"),
}
