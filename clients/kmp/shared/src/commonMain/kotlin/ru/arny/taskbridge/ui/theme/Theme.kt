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
import ru.arny.taskbridge.platform.SystemBarsAppearance

// Neutral graphite surfaces with one indigo accent: the chat is read for
// hours, so contrast comes from type and spacing, not saturated color. Status
// colors are the only loud ones, and each state keeps its hue in both themes.
// Dark is layered by lightness (deeper = further back), not by a blue tint.

private val Indigo = Color(0xFF4F5BD5)
private val IndigoLight = Color(0xFFA3ACFF)

private val LightColors = lightColorScheme(
    primary = Indigo,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE4E7FF),
    onPrimaryContainer = Color(0xFF151C5C),
    secondary = Color(0xFF5C5F6B),
    secondaryContainer = Color(0xFFE6E7EE),
    onSecondaryContainer = Color(0xFF1A1C24),
    tertiary = Color(0xFFB0306A),
    background = Color(0xFFFBFBFC),
    onBackground = Color(0xFF1B1C20),
    surface = Color(0xFFFBFBFC),
    onSurface = Color(0xFF1B1C20),
    surfaceVariant = Color(0xFFE7E8EC),
    onSurfaceVariant = Color(0xFF5B5E68),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color(0xFFF5F5F7),
    surfaceContainer = Color(0xFFEFEFF2),
    surfaceContainerHigh = Color(0xFFE9E9ED),
    surfaceContainerHighest = Color(0xFFE3E3E8),
    outline = Color(0xFF82848E),
    outlineVariant = Color(0xFFD9DAE0),
    error = Color(0xFFBA1A1A),
    errorContainer = Color(0xFFFFDAD6),
    onErrorContainer = Color(0xFF410002),
)

private val DarkColors = darkColorScheme(
    primary = IndigoLight,
    onPrimary = Color(0xFF151C5C),
    primaryContainer = Color(0xFF2E3677),
    onPrimaryContainer = Color(0xFFE0E3FF),
    secondary = Color(0xFFC3C5D0),
    secondaryContainer = Color(0xFF2C2E35),
    onSecondaryContainer = Color(0xFFE3E4EC),
    tertiary = Color(0xFFF2A7C8),
    background = Color(0xFF151619),
    onBackground = Color(0xFFE6E6EA),
    surface = Color(0xFF151619),
    onSurface = Color(0xFFE6E6EA),
    surfaceVariant = Color(0xFF2C2E34),
    onSurfaceVariant = Color(0xFFA4A7B1),
    surfaceContainerLowest = Color(0xFF0F1012),
    surfaceContainerLow = Color(0xFF1A1B1F),
    surfaceContainer = Color(0xFF1F2024),
    surfaceContainerHigh = Color(0xFF26272C),
    surfaceContainerHighest = Color(0xFF2E3035),
    outline = Color(0xFF6E717B),
    outlineVariant = Color(0xFF35373E),
    error = Color(0xFFFFB4AB),
    errorContainer = Color(0xFF5C1512),
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
    codeBackground = Color(0xFFF3F4F6),
    userBubble = Color(0xFFEDEFF9),
    onUserBubble = Color(0xFF1B1C20),
)

private val DarkStatus = StatusColors(
    waiting = Color(0xFFFBBF24),
    working = IndigoLight,
    queued = Color(0xFFC4B5FD),
    restorable = Color(0xFFFB923C),
    failed = Color(0xFFF87171),
    done = Color(0xFF4ADE80),
    muted = Color(0xFF7E818B),
    codeBackground = Color(0xFF0F1012),
    userBubble = Color(0xFF272A38),
    onUserBubble = Color(0xFFE6E6EA),
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
        SystemBarsAppearance(dark)
        MaterialTheme(colorScheme = colors, typography = AppTypography, shapes = AppShapes, content = content)
    }
}
