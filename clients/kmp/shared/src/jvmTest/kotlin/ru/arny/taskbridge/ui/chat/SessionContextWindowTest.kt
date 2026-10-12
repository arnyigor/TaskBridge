package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.ApiInfo
import ru.arny.taskbridge.core.api.CompactionInfo
import ru.arny.taskbridge.core.api.CompactionLast
import ru.arny.taskbridge.core.api.LocalModelEntry
import ru.arny.taskbridge.core.api.LocalModelMetrics
import ru.arny.taskbridge.core.api.LocalRuntimeInfo
import ru.arny.taskbridge.core.api.ModelRef
import ru.arny.taskbridge.core.api.Task
import ru.arny.taskbridge.core.api.Usage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Окно контекста сессии с локальной моделью берётся из живого статуса TaskBridge, а
 * не из каталога Pi: там у провайдера записан статический размер (262K из
 * models.json), и после загрузки модели с окном 131K шкала хода продолжала
 * показывать «30K/262K». Облачные модели остаются на каталожном числе — живого у
 * них нет.
 */
class SessionContextWindowTest {
    private fun info(vararg models: LocalModelEntry) = ApiInfo(local = LocalRuntimeInfo(models = models.toList()))

    private fun task(provider: String, id: String, catalog: Long?) = Task(
        id = "t1",
        model = ModelRef(provider = provider, id = id, contextWindow = catalog),
    )

    @Test
    fun aLocalModelUsesTheLiveWindowInsteadOfTheCatalogOne() {
        val live = info(LocalModelEntry(id = "qwen3.8-flash-next-iq3-s", provider = "strata-iq3s", contextWindow = 131072))
        assertEquals(131072, sessionContextWindow(task("strata-iq3s", "qwen3.8-flash-next-iq3-s", 262144), live))
    }

    @Test
    fun aCloudModelKeepsItsCatalogNumber() {
        val live = info(LocalModelEntry(id = "qwen3.8-flash-next-iq3-s", provider = "strata-iq3s", contextWindow = 131072))
        assertEquals(1_000_000, sessionContextWindow(task("deepseek", "deepseek-chat", 1_000_000), live))
    }

    @Test
    fun withoutALiveEntryTheCatalogNumberIsTheFallback() {
        assertEquals(262144, sessionContextWindow(task("strata-iq3s", "gone-model", 262144), info()))
        assertEquals(262144, sessionContextWindow(task("strata-iq3s", "gone-model", 262144), null))
        assertNull(sessionContextWindow(task("strata-iq3s", "gone-model", null), info()))
        assertNull(sessionContextWindow(null, info()))
    }

    @Test
    fun theRequestedModelIsUsedWhileTheSessionHasNoResolvedOne() {
        val live = info(LocalModelEntry(id = "qwen-27b-q3", provider = null, contextWindow = 102400))
        val pending = Task(id = "t1", requestedModel = ModelRef(provider = "llama.cpp", id = "qwen-27b-q3", contextWindow = 65536))
        assertEquals(102400, sessionContextWindow(pending, live))
    }

    /**
     * Реальный случай 2026-09-30: контекст модели опустили до 131072 на живой сессии,
     * чья история была 143930 токенов. Strata отвечает `400 prompt (144093 tokens) +
     * max tokens (32768) exceeds the context (131072)`, Pi повторяет запрос (41 попытка
     * за 4 минуты), панель показывает «Pi is working» без событий модели. Такую сессию
     * надо называть словами, а не оставлять «висит».
     */
    @Test
    fun aHistoryLongerThanTheLiveWindowIsReported() {
        val live = info(LocalModelEntry(id = "qwen3.8-flash-next-iq3-s", provider = "strata-iq3s", contextWindow = 131072))
        val long = Task(
            id = "t1",
            model = ModelRef(provider = "strata-iq3s", id = "qwen3.8-flash-next-iq3-s", contextWindow = 262144),
            lastUsage = Usage(input = 143016, output = 914, totalTokens = 143930),
        )
        assertEquals(143930L to 131072L, contextOverflow(long, live))
        // Каталожное 262144 не спасает: сравнивать надо с живым окном движка.
        val short = long.copy(lastUsage = Usage(input = 1000, output = 10, totalTokens = 1010))
        assertNull(contextOverflow(short, live))
        assertNull(contextOverflow(long, null))
    }

    /**
     * Контекст сессии в панели — число Pi (то же, что в «Настройках сессии» и в отчёте
     * `/api/tasks/:id/context`), а не размер запроса, который движок читает прямо
     * сейчас. 2026-10-08 панель показывала «Контекст 25% (50.4K/204.8K)» (живой запрос
     * движка), а настройки — «Всего в запросе: 99K токенов из 204K · 48%»: один и тот
     * же контекст читался двумя разными числами.
     *
     * Живое число движка осталось — отдельной строкой с подписью «Движок обрабатывает
     * промпт», поэтому прежний повод подменять им usage (2026-09-30: «читает 41.0K /
     * 63.7K» рядом с «55% (143.9K/262.1K)») больше не нужен.
     */
    @Test
    fun theSessionContextStaysPisNumberWhileTheEngineReadsAnother() {
        val reading = info(LocalModelEntry(
            id = "qwen3.8-flash-next-iq3-s", provider = "strata-iq3s", contextWindow = 262144,
            promptTotal = 63700,
            metrics = LocalModelMetrics(busy = true, promptTokens = 63651, promptTotal = 63700),
        ))
        val generating = info(LocalModelEntry(
            id = "qwen3.8-flash-next-iq3-s", provider = "strata-iq3s", contextWindow = 262144,
            metrics = LocalModelMetrics(busy = true, promptTokens = 63651),
        ))
        val idle = info(LocalModelEntry(
            id = "qwen3.8-flash-next-iq3-s", provider = "strata-iq3s", contextWindow = 262144,
            metrics = LocalModelMetrics(busy = false, promptTokens = 63651),
        ))
        val task = Task(
            id = "t1",
            model = ModelRef(provider = "strata-iq3s", id = "qwen3.8-flash-next-iq3-s", contextWindow = 262144),
            lastUsage = Usage(input = 143016, output = 914, totalTokens = 143930),
        )
        // Живой промпт движка по-прежнему виден — отдельной строкой.
        assertEquals(63700L, liveEnginePrompt(task.model, reading))
        assertEquals(63651L, liveEnginePrompt(task.model, generating))
        assertNull(liveEnginePrompt(task.model, idle))
        // А контекст сессии им не подменяется: это число Pi, одно во всех местах.
        assertEquals(143930L, sessionContextUsed(task))
        // Сжатие без нового хода: свежее число — оценка после сжатия.
        val compacted = task.copy(lastUsage = null, compaction = CompactionInfo(last = CompactionLast(estimatedTokensAfter = 9_901)))
        assertEquals(9_901L, sessionContextUsed(compacted))
        assertNull(sessionContextUsed(null))
        assertNull(liveEnginePrompt(task.model, null))
    }

    /**
     * Реальный случай 2026-09-30, 16:04: история 99.4K, окно 131072, резерв ответа
     * 32768. По сравнению истории с окном всё выглядело «76% заполнено», а движок
     * отклонял запрос: 99465 + 32768 + 8 = 132241 > 131072. Проверка обязана считать
     * резерв ответа — иначе предупреждения нет именно там, где сессия «висит».
     */
    @Test
    fun theAnswerReserveCountsTowardsTheWindow() {
        val live = info(LocalModelEntry(id = "qwen3.8-flash-next-iq3-s", provider = "strata-iq3s", contextWindow = 131072))
        val task = Task(
            id = "t1",
            model = ModelRef(provider = "strata-iq3s", id = "qwen3.8-flash-next-iq3-s", contextWindow = 262144, maxTokens = 32768),
            lastUsage = Usage(input = 98265, output = 1111, totalTokens = 99376),
        )
        assertEquals(99376L to 131072L, contextOverflow(task, live))
        // С окном 262144 (и живым числом 262144) тот же запас влезает — отказа нет.
        val fitsLive = info(LocalModelEntry(id = "qwen3.8-flash-next-iq3-s", provider = "strata-iq3s", contextWindow = 262144))
        assertNull(contextOverflow(task, fitsLive))
        // Без резервного поля сравнение по истории всё равно работает.
        val noReserve = Task(
            id = "t1",
            model = ModelRef(provider = "strata-iq3s", id = "qwen3.8-flash-next-iq3-s", contextWindow = 262144),
            lastUsage = Usage(input = 143016, output = 914, totalTokens = 143930),
        )
        assertEquals(143930L to 131072L, contextOverflow(noReserve, live))
    }

    /**
     * Живая сессия 8855fa011534 (openai-codex/gpt-5.5, 2026-10-12): история 217767
     * ток. при окне 272000 и `maxTokens` 128000 в каталоге. Панель объявляла, что
     * «история + резерв не влезает» и провайдер ответит 400, и советовала поднять окно
     * до 345775 — при том что сессия каждый ход получала ответ: промпт 217571 токен
     * прошёл, в записи хода есть usage и stop=stop, ошибок нет.
     *
     * Причина расхождения: адаптер Codex лимит вывода в запрос не кладёт вовсе
     * (`openai-codex-responses` собирает тело из model/store/stream/instructions/
     * input/text/include/prompt_cache_key/tool_choice/parallel_tool_calls). Резерва
     * в запросе нет — вычитать его из окна нельзя, и проверка остаётся только
     * «история против окна».
     */
    @Test
    fun theCodexReserveIsNotCountedBecauseItIsNeverSent() {
        val codex = ModelRef(provider = "openai-codex", id = "gpt-5.5", contextWindow = 272000, maxTokens = 128000)
        val live = Task(id = "t1", model = codex, lastUsage = Usage(input = 2019, output = 196, totalTokens = 217767))
        assertEquals(0L, answerReserveTokens(live))
        assertNull(contextOverflow(live, null))
        // Тот же провайдер, но история действительно больше окна — отказ настоящий.
        val tooLong = live.copy(lastUsage = Usage(input = 280000, output = 10, totalTokens = 280010))
        assertEquals(280010L to 272000L, contextOverflow(tooLong, null))
    }

    /**
     * У остальных провайдеров резерв остаётся: `openai-responses` шлёт
     * `max_output_tokens`, `openai-completions` — `max_completion_tokens`, anthropic
     * и mistral — `max_tokens`, google — `maxOutputTokens`.
     */
    @Test
    fun theReserveIsStillCountedWhereTheProviderSendsIt() {
        val openai = Task(
            id = "t1",
            model = ModelRef(provider = "openai", id = "gpt-4o", contextWindow = 128000, maxTokens = 16384),
            lastUsage = Usage(input = 120000, output = 10, totalTokens = 120010),
        )
        assertEquals(16384L, answerReserveTokens(openai))
        assertEquals(120010L to 128000L, contextOverflow(openai, null))
    }
}
