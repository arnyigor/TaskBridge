package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.unit.dp
import ru.arny.taskbridge.core.api.TurnMetrics
import ru.arny.taskbridge.core.client.chat.AnswerUsage
import java.util.Locale
import kotlin.test.*

@OptIn(ExperimentalTestApi::class)
class ResourceUsageInteractionTest {
    private val previousLocale = Locale.getDefault()
    @BeforeTest fun useRussian() { Locale.setDefault(Locale.forLanguageTag("ru-RU")) }
    @AfterTest fun restoreLocale() { Locale.setDefault(previousLocale) }

    private val details = UsageDetails(
        text = "legacy",
        usage = AnswerUsage(hit = 1_228_928, miss = 2_165, out = 4_559, cacheWrite = 0),
        metrics = TurnMetrics(durationMs = 42_000, firstTokenMs = 900, outputTokensPerSecond = 47.0),
        modelId = "provider/model",
        local = false,
        peak = false,
        multiplier = 1.0,
        cost = "$0.0138 · ≈ 1.12 ₽",
    )

    @Test
    fun englishResourcesAndNumberFormattingAreUsed() = runComposeUiTest {
        Locale.setDefault(Locale.US)
        setContent {
            MaterialTheme { Box(Modifier.width(480.dp)) { UsageDetailsTable(details) } }
        }
        onNodeWithText("Resource usage for this turn").assertExists()
        onNodeWithText("1,235,652 tokens").assertExists()
        onNodeWithText("99.8%").assertExists()
        onNodeWithText("0.9 s").assertExists()
        onNodeWithText("Uncached input").assertExists()
    }

    @Test
    fun keyboardOpensDismissesAndRestoresTriggerFocus() = runComposeUiTest {
        var expanded by mutableStateOf(false)
        setContent {
            MaterialTheme {
                Box(Modifier.size(640.dp, 600.dp).padding(top = 48.dp)) {
                    ResourceUsageBlock(details, expanded, { expanded = !expanded }, {}, desktop = true)
                }
            }
        }
        val trigger = onNodeWithContentDescription("Использование 1,2M ток · 42 с · $0,0138 · ≈ 1,12 ₽, Подробности использования ресурсов")
        trigger.performSemanticsAction(SemanticsActions.RequestFocus)
        trigger.performKeyInput { pressKey(Key.Enter) }
        onNodeWithText("Использование ресурсов за ход").assertExists()
        onNodeWithText("Закрыть").assertIsFocused().performKeyInput { pressKey(Key.Escape) }
        onNodeWithText("Использование ресурсов за ход").assertDoesNotExist()
        trigger.assertIsFocused().performKeyInput { pressKey(Key.Spacebar) }
        onNodeWithText("Использование ресурсов за ход").assertExists()
    }

    @Test
    fun outsideClickClosesThePopover() = runComposeUiTest {
        var expanded by mutableStateOf(false)
        setContent {
            MaterialTheme {
                Box(Modifier.size(640.dp, 600.dp).testTag("underlay")) {
                    Box(Modifier.padding(top = 150.dp)) {
                        ResourceUsageBlock(details, expanded, { expanded = !expanded }, {}, desktop = true)
                    }
                }
            }
        }
        onNodeWithText("Использование 1,2M ток · 42 с · $0,0138 · ≈ 1,12 ₽").performClick()
        onNodeWithText("Использование ресурсов за ход").assertExists()
        onNodeWithTag("underlay").performMouseInput { click(Offset(5f, 5f)) }
        waitForIdle()
        assertFalse(expanded)
        onNodeWithText("Использование ресурсов за ход").assertDoesNotExist()
    }

    @Test
    fun copyUsesTheVisibleLocalizedRowsWithoutClosingThePanel() = runComposeUiTest {
        var expanded by mutableStateOf(false)
        var copied: String? = null
        setContent {
            MaterialTheme {
                Box(Modifier.size(640.dp, 600.dp)) {
                    ResourceUsageBlock(details, expanded, { expanded = !expanded }, { copied = it }, desktop = true, status = "CANCELLED", segments = 3)
                }
            }
        }
        onNodeWithText("Использование 1,2M ток · 42 с · $0,0138 · ≈ 1,12 ₽").performClick()
        onNodeWithText("Копировать").performClick()
        assertTrue(expanded)
        assertNotNull(copied)
        assertTrue(copied!!.contains("Время работы (за 3 сегмента): 42 с"))
        assertTrue(copied!!.contains("1 235 652 ток"))
        assertTrue(copied!!.contains("Статус: Прервано"))
        assertTrue(copied!!.contains("Запись в кэш: 0 ток"))
    }

    @Test
    fun durationOnlyAndUnknownMetricsDoNotInventTokenOrSpeedRows() = runComposeUiTest {
        val timeOnly = details.copy(usage = null, metrics = TurnMetrics(durationMs = 0), modelId = null, cost = null)
        setContent { MaterialTheme { UsageDetailsTable(timeOnly) } }
        onNodeWithText("0,0 с").assertExists()
        onNodeWithText("Скорость генерации").assertDoesNotExist()
        onNodeWithText("0 ток").assertDoesNotExist()
        onNodeWithText("Поставщик/модель").assertDoesNotExist()
    }
}
