package ru.arny.taskbridge.ui.settings

import ru.arny.taskbridge.core.api.ApiInfo
import ru.arny.taskbridge.core.api.LocalEngineInfo
import ru.arny.taskbridge.core.api.LocalModelEntry
import ru.arny.taskbridge.core.api.LocalModelMetrics
import ru.arny.taskbridge.core.api.LocalRuntimeInfo
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Строка «Локальная модель» в «Состоянии компьютера».
 *
 * Регрессия 2026-11-11: статус выводился из метрик роутера llama.cpp, а они
 * ничего не знают о внешних серверах вроде Strata — запущенная модель
 * показывалась как «не запущена». Статус и метрики разделены: статус берётся из
 * списка моделей, скорости показываются только когда метрики реально есть.
 */
class LocalModelStatusTextTest {

    @Test
    fun externalServerWithoutRouterMetricsIsRunning() {
        // Strata поднят, роутер пуст: `reason: no-model` — это не «модель не запущена».
        val info = ApiInfo(
            local = LocalRuntimeInfo(
                enabled = true,
                reachable = true,
                models = listOf(
                    LocalModelEntry(id = "strata-iq3", name = "qwen3.8 iq3-xxs", provider = "strata", status = "loaded", external = true),
                ),
            ),
            engine = LocalEngineInfo(reachable = true, metrics = LocalModelMetrics(available = false, reason = "no-model")),
        )
        assertEquals("запущена: qwen3.8 iq3-xxs", localModelStatusText(info))
    }

    @Test
    fun routerWithMetricsNamesTheModel() {
        val info = ApiInfo(
            engine = LocalEngineInfo(
                reachable = true,
                metrics = LocalModelMetrics(available = true, model = "qwen-27b-q3", name = "Qwen 27B Q3"),
            ),
        )
        assertEquals("запущена: qwen-27b-q3", localModelStatusText(info))
    }

    @Test
    fun metricsDisabledStillMeansRunning() {
        // 501 от llama.cpp без --metrics: модель работает, скоростей просто нет.
        val info = ApiInfo(
            local = LocalRuntimeInfo(
                enabled = true,
                models = listOf(LocalModelEntry(id = "r1", status = "loaded")),
            ),
            engine = LocalEngineInfo(reachable = true, metrics = LocalModelMetrics(available = false, reason = "metrics-disabled", model = "r1")),
        )
        assertEquals("запущена: r1", localModelStatusText(info))
    }

    @Test
    fun loadingModelIsNotStopped() {
        val info = ApiInfo(
            local = LocalRuntimeInfo(
                enabled = true,
                models = listOf(LocalModelEntry(id = "r1", status = "loading", loadRatio = 0.4)),
            ),
            engine = LocalEngineInfo(reachable = true, metrics = LocalModelMetrics(available = false, reason = "no-model")),
        )
        assertEquals("загружается", localModelStatusText(info))
    }

    @Test
    fun allUnloadedIsTheOnlyHonestNotRunning() {
        val info = ApiInfo(
            local = LocalRuntimeInfo(
                enabled = true,
                models = listOf(
                    LocalModelEntry(id = "a", status = "unloaded"),
                    LocalModelEntry(id = "b", status = "unloaded"),
                ),
            ),
            engine = LocalEngineInfo(reachable = true, metrics = LocalModelMetrics(available = false, reason = "no-model")),
        )
        assertEquals("не запущена", localModelStatusText(info))
    }

    @Test
    fun emptyEngineIsUnknownNotStopped() {
        // Ничего не известно: ни списка моделей, ни метрик — «не запущена»
        // утверждало бы факт, которого у клиента нет.
        val info = ApiInfo(engine = LocalEngineInfo(reachable = false))
        assertEquals("состояние неизвестно", localModelStatusText(info))
    }
}
