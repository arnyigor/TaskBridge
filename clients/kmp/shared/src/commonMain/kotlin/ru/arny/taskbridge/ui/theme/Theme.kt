package ru.arny.taskbridge.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ru.arny.taskbridge.core.client.sessions.DisplayState

// A calm, readable palette: the chat is read for hours, so contrast comes from
// type and spacing rather than saturated color. Status colors are the only
// loud ones, and each state keeps its hue in both themes.

private val Indigo = Color(0xFF4F5BD5)
private val IndigoLight = Color(0xFFA9B1FF)

private val LightColors = lightColorScheme(
    primary = Indigo,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE3E6FF),
    onPrimaryContainer = Color(0xFF151C5C),
    secondary = Color(0xFF5B5F72),
    secondaryContainer = Color(0xFFE2E3F0),
    onSecondaryContainer = Color(0xFF181B2B),
    tertiary = Color(0xFF7A5362),
    background = Color(0xFFF8F8FC),
    onBackground = Color(0xFF1A1B21),
    surface = Color(0xFFF8F8FC),
    onSurface = Color(0xFF1A1B21),
    surfaceVariant = Color(0xFFE4E4EE),
    onSurfaceVariant = Color(0xFF474856),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color(0xFFF2F2F8),
    surfaceContainer = Color(0xFFECECF3),
    surfaceContainerHigh = Color(0xFFE6E6EE),
    surfaceContainerHighest = Color(0xFFE0E0E9),
    outline = Color(0xFF777888),
    outlineVariant = Color(0xFFC8C8D6),
    error = Color(0xFFBA1A1A),
    errorContainer = Color(0xFFFFDAD6),
    onErrorContainer = Color(0xFF410002),
)

private val DarkColors = darkColorScheme(
    primary = IndigoLight,
    onPrimary = Color(0xFF1B247A),
    primaryContainer = Color(0xFF343F9E),
    onPrimaryContainer = Color(0xFFE0E3FF),
    secondary = Color(0xFFC4C5DC),
    secondaryContainer = Color(0xFF43465A),
    onSecondaryContainer = Color(0xFFE0E1F8),
    tertiary = Color(0xFFE9B9CA),
    background = Color(0xFF121318),
    onBackground = Color(0xFFE3E2EA),
    surface = Color(0xFF121318),
    onSurface = Color(0xFFE3E2EA),
    surfaceVariant = Color(0xFF45464F),
    onSurfaceVariant = Color(0xFFC6C5D3),
    surfaceContainerLowest = Color(0xFF0D0E13),
    surfaceContainerLow = Color(0xFF1A1B21),
    surfaceContainer = Color(0xFF1E1F25),
    surfaceContainerHigh = Color(0xFF292A30),
    surfaceContainerHighest = Color(0xFF34343B),
    outline = Color(0xFF90909F),
    outlineVariant = Color(0xFF45464F),
    error = Color(0xFFFFB4AB),
    errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFDAD6),
)

@Immutable
data class StatusColors(
    val waiting: Color,
    val working: Color,
    val queued: Color,
    val restorable: Color,
    val failed: Color,
    val done: Color,
    val muted: Color,
    val codeBackground: Color,
    val userBubble: Color,
    val onUserBubble: Color,
) {
    fun of(state: DisplayState): Color = when (state) {
        DisplayState.WAITING_USER -> waiting
        DisplayState.WORKING -> working
        DisplayState.QUEUED -> queued
        DisplayState.RESTORABLE -> restorable
        DisplayState.FAILED -> failed
        DisplayState.DONE -> done
        DisplayState.CANCELLED, DisplayState.UNKNOWN -> muted
    }
}

private val LightStatus = StatusColors(
    waiting = Color(0xFFD97706),
    working = Indigo,
    queued = Color(0xFF7C3AED),
    restorable = Color(0xFFEA580C),
    failed = Color(0xFFDC2626),
    done = Color(0xFF16A34A),
    muted = Color(0xFF8A8B99),
    codeBackground = Color(0xFFF0F0F6),
    userBubble = Color(0xFFE3E6FF),
    onUserBubble = Color(0xFF151C5C),
)

private val DarkStatus = StatusColors(
    waiting = Color(0xFFFBBF24),
    working = IndigoLight,
    queued = Color(0xFFC4B5FD),
    restorable = Color(0xFFFB923C),
    failed = Color(0xFFF87171),
    done = Color(0xFF4ADE80),
    muted = Color(0xFF8E8FA0),
    codeBackground = Color(0xFF1B1C22),
    userBubble = Color(0xFF2C3480),
    onUserBubble = Color(0xFFE6E8FF),
)

val LocalStatusColors = staticCompositionLocalOf { LightStatus }

val MonoStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp, lineHeight = 19.sp)

private val AppTypography = Typography().let { base ->
    base.copy(
        titleLarge = base.titleLarge.copy(fontWeight = FontWeight.SemiBold),
        titleMedium = base.titleMedium.copy(fontWeight = FontWeight.SemiBold),
        bodyLarge = base.bodyLarge.copy(fontSize = 16.sp, lineHeight = 24.sp),
        bodyMedium = base.bodyMedium.copy(fontSize = 15.sp, lineHeight = 22.sp),
    )
}

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

/** "system" follows the OS; "light" / "dark" force it. */
@Composable
fun TaskBridgeTheme(mode: String = "system", content: @Composable () -> Unit) {
    val dark = when (mode) {
        "light" -> false
        "dark" -> true
        else -> isSystemInDarkTheme()
    }
    val colors: ColorScheme = if (dark) DarkColors else LightColors
    androidx.compose.runtime.CompositionLocalProvider(LocalStatusColors provides if (dark) DarkStatus else LightStatus) {
        MaterialTheme(colorScheme = colors, typography = AppTypography, shapes = AppShapes, content = content)
    }
}
