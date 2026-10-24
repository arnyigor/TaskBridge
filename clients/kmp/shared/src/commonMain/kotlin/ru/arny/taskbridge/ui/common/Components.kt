package ru.arny.taskbridge.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import ru.arny.taskbridge.core.client.sessions.DisplayState
import ru.arny.taskbridge.ui.theme.LocalStatusColors

/**
 * A small colored dot. Static on purpose: a pulse would keep the whole window repainting
 * 60 times a second while anything is running, and a working session is already readable
 * from the colour (and from the pill text next to it).
 */
@Composable
fun StatusDot(state: DisplayState, modifier: Modifier = Modifier, size: Int = 10) {
    val color = LocalStatusColors.current.of(state)
    Box(modifier.size(size.dp).clip(CircleShape).background(color))
}

/** "● Работает" — the state as a tinted pill. */
@Composable
fun StatusPill(state: DisplayState, modifier: Modifier = Modifier, text: String = state.label) {
    val color = LocalStatusColors.current.of(state)
    Row(
        modifier.clip(RoundedCornerShape(50)).background(color.copy(alpha = 0.14f)).padding(horizontal = 8.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StatusDot(state, size = 7)
        Spacer(Modifier.width(6.dp))
        Text(text, style = MaterialTheme.typography.labelMedium, color = color, maxLines = 1)
    }
}

/** A full-width strip for connection problems and warnings. */
@Composable
fun Banner(
    text: String,
    icon: ImageVector,
    color: Color,
    modifier: Modifier = Modifier,
    action: String? = null,
    onAction: (() -> Unit)? = null,
) {
    Surface(modifier.fillMaxWidth(), color = color.copy(alpha = 0.12f)) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, tint = color, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(10.dp))
            Text(
                softBreakLongText(text),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (action != null && onAction != null) TextButton(onClick = onAction) { Text(action) }
        }
    }
}

@Composable
fun AppSnackbarHost(hostState: SnackbarHostState, modifier: Modifier = Modifier) {
    SnackbarHost(hostState = hostState, modifier = modifier) { data ->
        val actionLabel = data.visuals.actionLabel
        Snackbar(
            action = actionLabel?.let { label ->
                { TextButton(onClick = { data.performAction() }) { Text(label) } }
            },
            dismissAction = if (data.visuals.withDismissAction) {
                { TextButton(onClick = { data.dismiss() }) { Text("Закрыть") } }
            } else null,
        ) {
            Text(
                softBreakLongText(data.visuals.message),
                maxLines = 4,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

fun softBreakLongText(text: String): String = buildString(text.length + text.length / 8) {
    var token = 0
    for (char in text) {
        append(char)
        if (char.isWhitespace()) {
            token = 0
            continue
        }
        token++
        if (char in "\\/,:;{}[]()=|" || token >= 16) {
            append('\u200B')
            token = 0
        }
    }
}

@Composable
fun EmptyState(icon: ImageVector, title: String, text: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    Column(
        modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(Modifier.size(64.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.size(30.dp))
        }
        Spacer(Modifier.height(16.dp))
        Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        Spacer(Modifier.height(6.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        if (action != null) {
            Spacer(Modifier.height(20.dp))
            action()
        }
    }
}

/**
 * Шаг ступенчатой анимации набора: ~3.6 смены фазы в секунду (цикл трёх точек — 840 мс,
 * против 1200 мс у плавной анимации до 66b89ec). 140 мс читались как мелькание, а
 * плавный tween вернул бы перерисовку всего окна 60 раз в секунду — поэтому ступени
 * замедлены, а не заменены анимацией.
 */
const val TYPING_STEP_MILLIS = 280L

/**
 * Общий источник фаз индикатора «агент пишет»: 0..2, без интерполяции между фазами.
 *
 * Точки не заводят собственных анимаций: пока [TypingPhase] получает `active = true`,
 * один таймер на экран меняет фазу каждые [TYPING_STEP_MILLIS] мс. Compose Desktop
 * перерисовывает всё окно на каждый кадр, а не только испорченную область, поэтому
 * 60-кадровая анимация трёх точек стоила столько же, сколько вся лента чата.
 */
val LocalTypingPhase = compositionLocalOf { 0 }

/** Включает общий таймер фаз на всё содержимое; [active] false — кадры не запрашиваются вообще. */
@Composable
fun TypingPhase(active: Boolean, content: @Composable () -> Unit) {
    var phase by remember { mutableIntStateOf(0) }
    if (active) {
        LaunchedEffect(Unit) {
            while (true) {
                delay(TYPING_STEP_MILLIS)
                phase = (phase + 1) % 3
            }
        }
    }
    CompositionLocalProvider(LocalTypingPhase provides phase, content = content)
}

/** Three dots that light up in turn: the model is writing. Stepped, not animated. */
@Composable
fun TypingIndicator(modifier: Modifier = Modifier) {
    val phase = LocalTypingPhase.current
    Row(modifier.padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        repeat(3) { index ->
            val alpha = when ((phase + index) % 3) {
                0 -> 1f
                1 -> 0.6f
                else -> 0.3f
            }
            Box(Modifier.size(7.dp).alpha(alpha).clip(CircleShape).background(MaterialTheme.colorScheme.onSurfaceVariant))
        }
    }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(),
        modifier = modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.primary,
    )
}

/** Строка «метка — значение» для информационных экранов (Настройки, Локальные модели). */
@Composable
fun InfoRow(label: String, value: String, icon: androidx.compose.ui.graphics.vector.ImageVector? = null, warning: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        if (icon != null) {
            Icon(icon, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(12.dp))
        }
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.width(140.dp))
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            color = if (warning) LocalStatusColors.current.waiting else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f),
        )
    }
}
