package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.ApiInfo
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
     * Пока движок занят, счётчик контекста должен показывать размер запроса в работе,
     * а не usage прошлого хода: 2026-09-30 в одной строке стояли «читает 41.0K / 63.7K»
     * (движок) и «55% (143.9K/262.1K)» (Pi за прошлый ход), и это выглядело багом.
     */
    @Test
    fun theLiveEnginePromptWinsOverThePreviousTurnUsage() {
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
        assertEquals(63700L, liveEnginePrompt(task.model, reading))
        assertEquals(63651L, liveEnginePrompt(task.model, generating))
        assertNull(liveEnginePrompt(task.model, idle))
        assertEquals(63700L, sessionContextUsed(task, reading))
        assertEquals(63651L, sessionContextUsed(task, generating))
        // Движок свободен — остаётся оценка Pi, другого числа нет.
        assertEquals(143930L, sessionContextUsed(task, idle))
        assertNull(liveEnginePrompt(task.model, null))
    }
}
