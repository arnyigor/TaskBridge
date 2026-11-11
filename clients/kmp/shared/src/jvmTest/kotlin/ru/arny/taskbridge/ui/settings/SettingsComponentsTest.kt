package ru.arny.taskbridge.ui.settings

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.unit.dp
import ru.arny.taskbridge.ui.theme.AppIcons
import ru.arny.taskbridge.ui.theme.TaskBridgeTheme
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Поведение переделанных настроек — на настоящей композиции, без сервера:
 * оглавление должно доводить до раздела, строка-переход — срабатывать целиком,
 * а кнопка питания — спрашивать, считать и отменяться.
 *
 * Сама `SettingsScreen` здесь не поднимается: ей нужен живой сервер. Проверяются
 * те части, из которых она собрана.
 */
@OptIn(ExperimentalTestApi::class)
class SettingsComponentsTest {

    private fun ComposeUiTest.setIndexedContent(offsets: MutableMap<String, Int>, scroll: ScrollState) {
        setContent {
            TaskBridgeTheme {
                // Как в настройках: оглавление закреплено, содержимое прокручивается под ним.
                Column(Modifier.fillMaxWidth()) {
                    SettingsIndex(scroll, offsets)
                    Column(Modifier.fillMaxWidth().verticalScroll(scroll)) {
                    SettingsSectionHeader("Это устройство", offsets)
                    Spacer(Modifier.height(600.dp))
                    SettingsSectionHeader("Агент и очередь", offsets)
                    Spacer(Modifier.height(600.dp))
                    SettingsSectionHeader("Балансы и лимиты провайдеров", offsets)
                    Spacer(Modifier.height(600.dp))
                    SettingsSectionHeader("Питание и подключение", offsets)
                    Spacer(Modifier.height(600.dp))
                    }
                }
            }
        }
        waitForIdle()
    }

    @Test
    fun indexScrollsToTheSectionItNames() = runComposeUiTest {
        val offsets = mutableMapOf<String, Int>()
        val scroll = ScrollState(0)
        setIndexedContent(offsets, scroll)
        assertEquals(0, scroll.value, "страница открывается сверху")

        onNodeWithText("Балансы").performClick()
        waitForIdle()

        val expected = offsets["Балансы и лимиты провайдеров"] ?: error("раздел не измерен")
        assertTrue(expected > 0, "у раздела есть смещение в прокрутке")
        assertEquals(expected, scroll.value, "чип доводит именно до своего раздела")

        onNodeWithText("Устройство").performClick()
        waitForIdle()
        assertEquals(0, scroll.value, "верхний раздел возвращает к началу")
    }

    @Test
    fun navRowShowsBothLinesAndOpensItsScreen() = runComposeUiTest {
        val clicks = mutableListOf<String>()
        setContent {
            TaskBridgeTheme {
                SettingsCard(title = "Управление") {
                    SettingsNavRow(AppIcons.Tool, "Модели Pi и подключения", "провайдеров: 5 · моделей: 42") {
                        clicks += "pi"
                    }
                    SettingsNavRow(AppIcons.Layers, "Локальные модели", "установлено 2 · запущено 0") {
                        clicks += "local"
                    }
                }
            }
        }
        waitForIdle()

        // Сводка — часть кликабельной строки, а не отдельная подпись: нажатие по ней
        // должно открывать экран так же, как нажатие по названию.
        onNodeWithText("провайдеров: 5 · моделей: 42").performClick()
        onNodeWithText("Локальные модели").performClick()
        assertEquals(listOf("pi", "local"), clicks)
    }

    @Test
    fun powerButtonAsksBeforeDoingAnything() = runComposeUiTest {
        var shutdowns = 0
        val modal: MutableState<Boolean> = mutableStateOf(false)
        setContent {
            TaskBridgeTheme {
                PowerSection(
                    kind = "desktop",
                    shutdown = { shutdowns += 1 },
                    reboot = { error("перезагрузка в этом тесте не нажималась") },
                    onDisconnect = {},
                    onExit = {},
                    onModalChange = { modal.value = it },
                )
            }
        }
        waitForIdle()
        assertEquals(false, modal.value, "без диалога экран продолжает опрашивать статус")

        // Само окно диалога живёт вне дерева семантики теста, поэтому проверяется
        // то, что видит экран: нажатие только спрашивает и останавливает опрос,
        // команда на компьютер не уходит до подтверждения и отсчёта.
        onNodeWithText("Выключить компьютер").performClick()
        waitForIdle()
        assertEquals(true, modal.value, "кнопка открывает подтверждение")
        assertEquals(0, shutdowns, "без подтверждения команда не отправляется")
    }

    @Test
    fun metricRowShowsTheNumberAndItsFill() = runComposeUiTest {
        setContent {
            TaskBridgeTheme {
                SettingsCard(title = "Нагрузка машины") {
                    MetricRow("RAM", "21.1 ГБ / 127.9 ГБ (16%)", 0.16)
                }
            }
        }
        waitForIdle()
        onNodeWithText("21.1 ГБ / 127.9 ГБ (16%)").assertExists()
        onNodeWithText("Нагрузка машины").assertExists()
    }
}
