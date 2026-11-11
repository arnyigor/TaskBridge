package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.unit.dp
import ru.arny.taskbridge.core.api.TurnMetrics
import ru.arny.taskbridge.core.client.chat.AnswerUsage
import ru.arny.taskbridge.core.client.chat.ChatItem
import kotlin.test.Test
import kotlin.test.BeforeTest
import kotlin.test.AfterTest
import java.util.Locale

/**
 * Блок ресурсов под ответом: свёрнутая подпись с временем, метка пика и
 * раскрывающаяся таблица с точными числами.
 */
@OptIn(ExperimentalTestApi::class)
class MessageUsageLineRenderTest {
    private val previousLocale = Locale.getDefault()
    @BeforeTest fun useRussian() { Locale.setDefault(Locale.forLanguageTag("ru-RU")) }
    @AfterTest fun restoreLocale() { Locale.setDefault(previousLocale) }

    private fun answer() = ChatItem.Assistant(
        "assistant-initial", "Ответ", "", emptyList(), active = false, status = "SUCCEEDED", error = null,
        final = true, at = null, endedAt = null, partial = false, superseded = false, stopReason = null, variants = null,
    )

    private fun actions() = MessageActions(copy = {})

    /** Данные примера из ТЗ: 1 228 928 + 2 165 + 4 559 = 1 235 652. */
    private fun details(peak: Boolean = false) = UsageDetails(
        text = "1.2M ток · 42 с · $0.0138 · ≈ 1.12 ₽",
        usage = AnswerUsage(hit = 1_228_928, miss = 2_165, out = 4_559, cacheWrite = 0),
        metrics = TurnMetrics(durationMs = 42_000, firstTokenMs = 900, outputTokensPerSecond = 47.0),
        modelId = "deepseek-flash",
        local = false,
        peak = peak,
        multiplier = 2.0,
        cost = "$0.0138 · ≈ 1.12 ₽",
    )

    @Test
    fun collapsedLineAndPeakBadgeAreShownUnderTheAnswer() = runComposeUiTest {
        setContent {
            MaterialTheme {
                Box(Modifier.width(360.dp)) {
                    AssistantMessage(
                        item = answer(),
                        time = "14:32 · 1 мин 20 с",
                        actions = actions(),
                        onCopyText = {},
                        loadToolOutput = { error("unused") },
                        onOpenPath = {},
                        onSelectVariant = {},
                        onOpenFile = { _, _ -> },
                        loadFile = { error("unused") },
                        loadWorkspaceFile = { error("unused") },
                        desktop = false,
                        usageDetails = details(peak = true),
                    )
                }
            }
        }
        onNodeWithText("Использование 1,2M ток · 42 с · $0,0138 · ≈ 1,12 ₽").assertExists()
        onNodeWithText("пик ×2").assertExists()
    }

    @Test
    fun noPeakBadgeWithoutPeak() = runComposeUiTest {
        setContent {
            MaterialTheme {
                Box(Modifier.width(360.dp)) {
                    AssistantMessage(
                        item = answer(),
                        time = "14:32",
                        actions = actions(),
                        onCopyText = {},
                        loadToolOutput = { error("unused") },
                        onOpenPath = {},
                        onSelectVariant = {},
                        onOpenFile = { _, _ -> },
                        loadFile = { error("unused") },
                        loadWorkspaceFile = { error("unused") },
                        desktop = false,
                        usageDetails = details(peak = false),
                    )
                }
            }
        }
        onNodeWithText("пик ×2").assertDoesNotExist()
    }

    /** Раскрытая таблица: точные числа, сумма строк сходится с итогом. */
    @Test
    fun expandedTableShowsExactNumbers() = runComposeUiTest {
        setContent {
            MaterialTheme {
                Box(Modifier.width(360.dp)) {
                    UsageDetailsTable(details())
                }
            }
        }
        onNodeWithText("Использование ресурсов за ход").assertExists()
        onNodeWithText("1\u00A0235\u00A0652 ток").assertExists()
        onNodeWithText("99,8%").assertExists()
        onNodeWithText("2\u00A0165 ток").assertExists()
        onNodeWithText("1\u00A0228\u00A0928 ток").assertExists()
        onNodeWithText("0 ток").assertExists()
        onNodeWithText("4\u00A0559 ток").assertExists()
        onNodeWithText("42 с").assertExists()
        onNodeWithText("0,9 с").assertExists()
        onNodeWithText("47 ток/с").assertExists()
        onNodeWithText("$0,0138 · ≈ 1,12 ₽").assertExists()
    }

    /** Нажатие на плашку переключает раскрытие через колбэк экрана. */
    @Test
    fun tappingTheBarTogglesExpansion() = runComposeUiTest {
        var toggled = 0
        setContent {
            MaterialTheme {
                Box(Modifier.width(360.dp)) {
                    AssistantMessage(
                        item = answer(),
                        time = "14:32",
                        actions = actions(),
                        onCopyText = {},
                        loadToolOutput = { error("unused") },
                        onOpenPath = {},
                        onSelectVariant = {},
                        onOpenFile = { _, _ -> },
                        loadFile = { error("unused") },
                        loadWorkspaceFile = { error("unused") },
                        desktop = false,
                        usageDetails = details(),
                        onToggleUsage = { toggled++ },
                    )
                }
            }
        }
        onNodeWithText("Использование 1,2M ток · 42 с · $0,0138 · ≈ 1,12 ₽").performClick()
        kotlin.test.assertEquals(1, toggled)
    }

    /** Неизвестные значения не рисуются, известный ноль — рисуется. */
    @Test
    fun unknownRowsAreHiddenAndKnownZeroIsShown() = runComposeUiTest {
        val partial = UsageDetails(
            text = "110 ток · 2 с",
            usage = AnswerUsage(miss = 100, out = 10, cacheWrite = 0),
            metrics = TurnMetrics(durationMs = 2_000),
            modelId = null,
            local = false,
            peak = false,
            multiplier = 1.0,
            cost = null,
        )
        setContent {
            MaterialTheme {
                Box(Modifier.width(360.dp)) { UsageDetailsTable(partial) }
            }
        }
        onNodeWithText("Кэшированный ввод").assertDoesNotExist()
        onNodeWithText("0 ток").assertExists()
        onNodeWithText("100 ток").assertExists()
        onNodeWithText("110 ток").assertExists()
        // Процент кэша без одного из входных счётчиков не вычисляется — строки нет.
        onNodeWithText("Попадание в кэш").assertDoesNotExist()
        onNodeWithText("Поставщик/модель").assertDoesNotExist()
    }

    /** Прерванный ход: статус — строкой таблицы, рядом с фактическим временем. */
    @Test
    fun statusIsPartOfTheTable() = runComposeUiTest {
        setContent {
            MaterialTheme {
                Box(Modifier.width(360.dp)) {
                    UsageDetailsTable(details(), statusLabel = "Прервано", onCopy = {})
                }
            }
        }
        onNodeWithText("Статус").assertExists()
        onNodeWithText("Прервано").assertExists()
        onNodeWithText("Копировать").assertExists()
    }
}
