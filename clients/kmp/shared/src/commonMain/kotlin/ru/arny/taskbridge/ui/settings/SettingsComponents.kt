package ru.arny.taskbridge.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.ScrollState
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ru.arny.taskbridge.ui.common.SectionTitle
import ru.arny.taskbridge.ui.theme.AppIcons
import kotlin.math.roundToInt

/**
 * Карточка раздела настроек: заголовок с пояснением и содержимое с общими отступами.
 *
 * Настройки — длинный экран, и плоский список строк читался как одна таблица:
 * нельзя было понять, где кончается «компьютер» и начинаются «провайдеры».
 * Границей служит поверхность, а не ещё один заголовок.
 */
@Composable
internal fun SettingsCard(
    title: String,
    subtitle: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Surface(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Column(Modifier.padding(vertical = 6.dp)) {
            Row(
                Modifier.fillMaxWidth().padding(start = 12.dp, end = 8.dp, top = 8.dp, bottom = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(title, style = MaterialTheme.typography.titleSmall)
                    if (subtitle != null) {
                        Text(
                            subtitle,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            content()
        }
    }
}

/**
 * Строка перехода на отдельный экран: иконка, название и живая сводка.
 *
 * Раньше переходы были текстовыми кнопками без рамки и стрелки, и отличить
 * «открыть экран» от «выполнить действие» было нельзя.
 */
@Composable
internal fun SettingsNavRow(
    icon: ImageVector,
    title: String,
    summary: String,
    onClick: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(
                summary,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.width(8.dp))
        Icon(AppIcons.ChevronRight, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * Строка нагрузки: подпись, значение и полоса заполнения, когда доля известна.
 *
 * «21.1 ГБ / 127.9 ГБ (16%)» в одну строку приходилось читать трижды, чтобы
 * понять, много это или мало: полоса отвечает на это без чтения.
 */
@Composable
internal fun MetricRow(label: String, value: String, ratio: Double?) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = MaterialTheme.typography.labelLarge, modifier = Modifier.width(72.dp))
            Text(
                value,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
        }
        if (ratio != null && ratio.isFinite()) {
            Spacer(Modifier.height(5.dp))
            LinearProgressIndicator(
                progress = { ratio.coerceIn(0.0, 1.0).toFloat() },
                modifier = Modifier.fillMaxWidth().height(4.dp),
            )
        }
    }
}

/** Короткие подписи разделов для оглавления: полные заголовки в чипы не влезают. */
internal val settingsSections = listOf(
    "Это устройство" to "Устройство",
    "Компьютер" to "Компьютер",
    "Модели и провайдеры" to "Модели",
    "Состояние компьютера" to "Нагрузка",
    "Агент и очередь" to "Очередь",
    "Балансы и лимиты провайдеров" to "Балансы",
    "MCP" to "MCP",
    "Питание и подключение" to "Питание",
)

/**
 * Заголовок раздела, который помнит своё место в прокрутке.
 *
 * Настройки — один длинный скролл: без оглавления «переключить тему» и «выключить
 * компьютер» находятся на разных концах страницы, и до второго нужно листать
 * мимо всей диагностики.
 */
@Composable
internal fun SettingsSectionHeader(title: String, offsets: MutableMap<String, Int>) {
    SectionTitle(
        title,
        modifier = Modifier.onGloballyPositioned { coordinates ->
            offsets[title] = coordinates.positionInParent().y.roundToInt()
        },
    )
}

/**
 * Оглавление настроек: строка чипов, которая остаётся на месте при прокрутке.
 *
 * Внутри прокручиваемого содержимого оно уезжало вместе со страницей и помогало
 * только один раз — вернуться к верхним разделам было нечем. Одна строка вместо
 * переноса: на телефоне восемь чипов в две-три строки съедали бы пол-экрана.
 */
@Composable
internal fun SettingsIndex(scroll: ScrollState, offsets: Map<String, Int>) {
    val scope = rememberCoroutineScope()
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for ((title, label) in settingsSections) {
            AssistChip(
                onClick = { scope.launch { scroll.animateScrollTo(offsets[title] ?: 0) } },
                label = { Text(label) },
            )
        }
    }
}
