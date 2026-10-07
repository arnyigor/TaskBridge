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
    val medianPerDay: Double? = null,
    val recentPerDayRub: Double? = null,
    val historyPerDayRub: Double? = null,
    val medianPerDayRub: Double? = null,
    val medianMonthlyRub: Double? = null,
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

/** Folders exposed by the server inside projectBrowser.roots. */
@Serializable
data class ProjectFolder(val name: String, val path: String)

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

@Serializable
data class Task(
    val id: String,
    val title: String? = null,
    val prompt: String? = null,
    val projectId: String? = null,
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
    val pendingPrompts: List<PendingPrompt> = emptyList(),
    val files: List<FileRef> = emptyList(),
    val outputFiles: List<FileRef> = emptyList(),
    val lastUsage: Usage? = null,
    val metrics: GenerationMetrics? = null,
    val compaction: CompactionInfo? = null,
    val autoCompactionEnabled: Boolean? = null,
    /** Лимит контекста сессии в токенах; null — без лимита (см. SessionContextReport). */
    val contextLimit: Long? = null,
    val sessionAvailable: Boolean? = null,
    val assistantText: String? = null,
    val thinkingText: String? = null,
    val retryable: Boolean? = null,
    val runtime: RuntimeInfo? = null,
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
