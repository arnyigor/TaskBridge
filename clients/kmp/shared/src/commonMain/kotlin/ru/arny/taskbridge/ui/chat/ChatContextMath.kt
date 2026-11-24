package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.ApiInfo
import ru.arny.taskbridge.core.api.ModelRef
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.ui.common.parseIsoMillis

/**
 * Математика контекста: окно модели, занятость, оценка, переполнение и резерв
 * ответа. Вынесено из ChatScreen.kt без изменения поведения.
 *
 * Файл без Compose-зависимостей: чистые функции над Task/ApiInfo/ModelRef,
 * тестируются на JVM напрямую (ChatContextMathTest). Источники и порядок
 * fallback-цепочек — контракт, закреплённый этими тестами.
 */

/**
 * Живое окно контекста локальной модели из статуса TaskBridge (конфиг движка и
 * `/health` его сервера), или null — для облачной модели такого числа нет.
 */
internal fun liveLocalContextWindow(model: ModelRef?, info: ApiInfo?): Long? =
    model?.let { ref ->
        info?.local?.models?.firstOrNull { entry ->
            (ref.id != null && entry.id == ref.id) || (ref.provider != null && entry.provider == ref.provider)
        }
    }?.contextWindow

/**
 * Окно контекста сессии. У локальной модели каталожное число — это статическая
 * запись провайдера в Pi (262K из models.json): после загрузки с другим окном она
 * остаётся прежней, и шкала показывала «30K/262K», хотя движок поднят на 131K.
 * Поэтому для местных моделей берём живое число TaskBridge, а каталог Pi остаётся
 * фолбэком — для облачных моделей он и есть единственный источник.
 */
internal fun sessionContextWindow(task: Task?, info: ApiInfo?): Long? {
    val model = task?.model ?: task?.requestedModel
    return liveLocalContextWindow(model, info) ?: model?.contextWindow
}

/**
 * Размер промпта, который движок (Strata) обрабатывает прямо сейчас для этой модели,
 * или null если он не занят.
 *
 * Пока движок занят, важен именно этот размер: панель иначе показывает `usage`
 * прошлого хода — в замере 2026-09-30 рядом стояли «читает 41.0K / 63.7K» от
 * движка и «55% (143.9K/262.1K)» от Pi, и это читалось как баг. Свежий запрос
 * всегда последний в счётчиках движка, поэтому число относится к текущему ходу.
 */
internal fun liveEnginePrompt(model: ModelRef?, info: ApiInfo?): Long? {
    val entry = model?.let { ref ->
        info?.local?.models?.firstOrNull { item ->
            (ref.id != null && item.id == ref.id) || (ref.provider != null && item.provider == ref.provider)
        }
    } ?: return null
    val metrics = entry.metrics ?: return null
    if (metrics.busy != true) return null
    // Во время чтения промпта движок знает точный размер, после — счётчик запроса.
    return entry.promptTotal?.takeIf { it > 0 } ?: metrics.promptTokens?.takeIf { it > 0 }
}

/**
 * Сколько токенов занимает контекст сессии по числам Pi — то же число, что в
 * настройках сессии («Текущий размер контекста (Pi)» из `get_session_stats.contextUsage`).
 *
 * Размер промпта, который движок обрабатывает прямо сейчас (`liveEnginePrompt`), сюда
 * не подставляется: 2026-10-08 панель показывала «Контекст 25% (50.4K/204.8K)» (живой
 * запрос движка), а настройки — «Всего в запросе: 99K из 204K · 48%», и один и тот же
 * контекст читался двумя разными числами. Живое число движка показывается отдельной
 * строкой с подписью «Движок обрабатывает промпт».
 */
internal fun sessionContextUsed(task: Task?): Long? =
    if (sessionMeasurementCurrent(task)) task?.lastUsage?.totalTokens
    else task?.compaction?.last?.estimatedTokensAfter

/**
 * Относится ли `lastUsage` к тому контексту, который в сессии сейчас.
 *
 * После успешного сжатия `lastUsage` остаётся прежним намеренно: это измерение
 * прошлого запроса, а не оценка нового размера. Без времени съёма отличить его от
 * свежего невозможно — и панель показывала 455007 ток. (ровно `tokensBefore`), когда
 * в контексте было ≈35K (живой отчёт 2026-11-15).
 *
 * Старая задача без `lastUsageAt` считается измеренной: времени съёма в ней нет,
 * и подменять последнее известное число догадкой нельзя.
 */
internal fun sessionMeasurementCurrent(task: Task?): Boolean {
    val usage = task?.lastUsage ?: return false
    if ((usage.totalTokens ?: 0L) <= 0) return false
    val measuredAt = parseIsoMillis(task.lastUsageAt) ?: return true
    val compactedAt = parseIsoMillis(task.compaction?.last?.at) ?: return true
    return measuredAt >= compactedAt
}

/** Число в `sessionContextUsed` — оценка Pi после сжатия, а не измерение. */
internal fun sessionContextEstimated(task: Task?): Boolean =
    !sessionMeasurementCurrent(task) && task?.compaction?.last?.estimatedTokensAfter != null

/**
 * История с резервом ответа не влезает в окно модели, или null если влезает (или
 * одного из чисел нет).
 *
 * Это тот случай, когда «сессия подвисла» на самом деле ждёт: движок (Strata и
 * llama.cpp) НЕ обрезает промпт, а отвечает 400 `prompt (N tokens) + max tokens
 * (M) exceeds the context (K); requests are never truncated`, а Pi повторяет такие
 * запросы с паузой. В логе сессии это видно как `limits-wait` с `retries_total`,
 * в панели — как «streaming · Pi is working» без событий модели.
 *
 * Правило движка — промпт + резерв ответа + 8 ≤ окно, поэтому одного сравнения
 * истории с окном мало: 2026-09-30 при истории 99.4K и окне 131072 всё выглядело
 * «76% заполнено», а запрос всё равно отклонялся: 99465 + 32768 + 8 = 132241.
 *
 * Резерв берётся не из каталога, а из того, что провайдер действительно отправляет
 * (см. answerReserveTokens): у Codex его нет вовсе, и там правило сводится к
 * «история против окна».
 */
internal fun contextOverflow(task: Task?, info: ApiInfo?): Pair<Long, Long>? {
    val window = sessionContextWindow(task, info)?.takeIf { it > 0 } ?: return null
    val tokens = sessionContextUsed(task) ?: return null
    val reserve = answerReserveTokens(task)
    return if (tokens + reserve > window) tokens to window else null
}

/**
 * Отправляет ли провайдер лимит вывода полем запроса.
 *
 * Лимит вывода есть у всех адаптеров Pi, кроме Codex: `openai-codex-responses`
 * собирает тело запроса из model/store/stream/instructions/input/text/include/
 * prompt_cache_key/tool_choice/parallel_tool_calls, и поля лимита вывода там нет
 * ни одного (проверено по установленному пакету 2026-10-12). У остальных — есть:
 * openai-responses (`max_output_tokens`), openai-completions (`max_completion_tokens`/
 * `max_tokens`), anthropic и mistral (`max_tokens`), google (`maxOutputTokens`).
 */
internal fun providerSendsOutputLimit(provider: String?): Boolean = provider != "openai-codex"

/**
 * Резерв ответа — сколько токенов провайдер держит под ответ в том же запросе.
 *
 * Число в каталоге модели — это её потолок вывода, а не обязательство провайдера:
 * Codex лимит вывода не отправляет, поэтому `maxTokens` 128000 у gpt-5.5 в окне
 * 272000 не занимает ничего, и вычитать его из окна нельзя.
 *
 * Проверено на живой сессии 8855fa011534 (openai-codex/gpt-5.5, окно 272000):
 * промпт 217571 токен прошёл и ответ получен, а сравнение с резервом объявляло
 * именно эту сессию «не влезает в окно» (217767 + 128000 > 272000) и советовало
 * поднять окно до 345775.
 */
internal fun answerReserveTokens(task: Task?): Long {
    val model = task?.model ?: task?.requestedModel ?: return 0
    if (!providerSendsOutputLimit(model.provider)) return 0
    return model.maxTokens ?: 0
}

/**
 * Идёт ли чтение промпта прямо сейчас.
 *
 * Признаки только живые: фаза движка (Strata отдаёт «reading the prompt») или его PP
 * из `/api/info`. PP прошлого хода (`task.metrics.pp`) сюда не попадает: он не
 * гаснет после ответа, и с ним «Модель читает промпт» висела над уже идущими
 * размышлениями — пока в ответе не появится текст, то есть всё время работы think-
 * блока. Пока модель выдала что-то видимое ([answerSilent] == false), чтения нет.
 */
internal fun readsPromptNow(readingPrompt: Boolean, livePp: Double?, answerSilent: Boolean): Boolean =
    answerSilent && (readingPrompt || livePp != null)
