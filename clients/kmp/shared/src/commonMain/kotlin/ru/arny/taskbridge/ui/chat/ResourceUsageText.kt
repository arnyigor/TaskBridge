package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.*
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.intl.Locale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import kotlinx.coroutines.launch

/** A focusable desktop popover, or a phone bottom sheet. All data is already in the message. */
@Composable
fun ResourceUsageBlock(
    details: UsageDetails,
    expanded: Boolean,
    onToggle: () -> Unit,
    onCopy: (String) -> Unit,
    desktop: Boolean,
    status: String? = null,
    segments: Int = 0,
) {
    val labels = usageLabels(segments, multiplierText(details.multiplier))
    val tag = Locale.current.toLanguageTag()
    val localizedStatus = when (status) {
        "FAILED" -> labels.failed
        "CANCELLED", "aborted" -> labels.interrupted
        else -> null
    }
    val presentation = remember(details, labels, tag, localizedStatus, segments) {
        presentUsage(details, labels, tag, segments, localizedStatus)
    }
    val triggerFocus = remember { FocusRequester() }
    val panelFocus = remember { FocusRequester() }
    val scope = rememberCoroutineScope()
    var triggerHeight by remember { mutableIntStateOf(0) }
    val dismiss = {
        onToggle()
        scope.launch {
            withFrameNanos { }
            triggerFocus.requestFocus()
        }
        Unit
    }
    val panel: @Composable () -> Unit = {
        Column(
            Modifier.onPreviewKeyEvent {
                if (it.key == Key.Escape && it.type == KeyEventType.KeyDown) {
                    dismiss()
                    true
                } else false
            },
        ) {
            SelectionContainer { UsageTableContent(presentation, labels.title) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = { onCopy(presentation.copyText) }) { Text(labels.copy) }
                TextButton(onClick = dismiss, modifier = Modifier.focusRequester(panelFocus)) { Text(labels.close) }
            }
        }
        LaunchedEffect(Unit) { panelFocus.requestFocus() }
    }
    Box(Modifier.padding(top = 6.dp)) {
        UsageSummaryBar(
            text = presentation.summary,
            peak = details.peak,
            expanded = expanded,
            onToggle = { if (expanded) dismiss() else onToggle() },
            modifier = Modifier.focusRequester(triggerFocus).onSizeChanged { triggerHeight = it.height },
            badge = labels.peakBadge,
            expandedLabel = labels.expanded,
            collapsedLabel = labels.collapsed,
            actionLabel = labels.details,
        )
        if (expanded && desktop) {
            val window = LocalWindowInfo.current.containerSize
            val density = LocalDensity.current
            val width = with(density) { (window.width.toDp() - 32.dp).coerceIn(160.dp, 520.dp) }
            val height = with(density) { (window.height.toDp() - 48.dp).coerceAtLeast(120.dp) }
            Popup(
                alignment = Alignment.TopStart,
                offset = IntOffset(0, triggerHeight),
                onDismissRequest = dismiss,
                properties = PopupProperties(focusable = true, dismissOnClickOutside = true, dismissOnBackPress = true),
            ) {
                Surface(shape = MaterialTheme.shapes.medium, shadowElevation = 8.dp) {
                    Box(Modifier.width(width).heightIn(max = height).verticalScroll(rememberScrollState()).padding(12.dp)) { panel() }
                }
            }
        } else if (expanded) {
            ModalBottomSheet(onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
                Box(Modifier.fillMaxWidth().navigationBarsPadding().heightIn(max = 640.dp).verticalScroll(rememberScrollState()).padding(16.dp)) { panel() }
            }
        }
    }
}

/** Standalone table used in previews/tests; the live message uses the same presentation. */
@Composable
fun UsageDetailsTable(
    details: UsageDetails,
    modifier: Modifier = Modifier,
    statusLabel: String? = null,
    segments: Int = 0,
    onCopy: (() -> Unit)? = null,
) {
    val labels = usageLabels(segments, multiplierText(details.multiplier))
    val tag = Locale.current.toLanguageTag()
    val presentation = remember(details, labels, tag, statusLabel, segments) {
        presentUsage(details, labels, tag, segments, statusLabel)
    }
    Surface(modifier.widthIn(max = 640.dp), shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Column(Modifier.fillMaxWidth().padding(14.dp)) {
            SelectionContainer { UsageTableContent(presentation, labels.title) }
            if (onCopy != null) TextButton(onClick = onCopy) { Text(labels.copy) }
        }
    }
}

@Composable
private fun UsageTableContent(presentation: UsagePresentation, title: String) {
    Column(Modifier.fillMaxWidth()) {
        Text(title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.semantics { heading() })
        presentation.total?.let {
            Text(it, Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.primary,
                style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, textAlign = TextAlign.End)
        }
        Spacer(Modifier.height(6.dp))
        presentation.rows.forEach { (label, value) -> UsageRow(label, value) }
    }
}

@Composable
private fun UsageRow(label: String, value: String) {
    BoxWithConstraints(Modifier.fillMaxWidth().padding(vertical = 3.dp).semantics(mergeDescendants = true) {}) {
        if (maxWidth < 320.dp) {
            Column(Modifier.fillMaxWidth()) {
                Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(value, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
            }
        } else {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text(label, Modifier.weight(1f).padding(end = 12.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(value, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium, textAlign = TextAlign.End)
            }
        }
    }
}

@Composable
fun UsageSummaryBar(
    text: String,
    peak: Boolean,
    expanded: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
    badge: String,
    expandedLabel: String,
    collapsedLabel: String,
    actionLabel: String,
) {
    val interaction = remember { MutableInteractionSource() }
    Surface(
        modifier.onPreviewKeyEvent {
            if (it.key == Key.Spacebar) {
                if (it.type == KeyEventType.KeyUp) onToggle()
                true
            } else false
        }.clickable(interactionSource = interaction, indication = null, role = Role.Button,
            onClickLabel = actionLabel, onClick = onToggle).semantics {
            contentDescription = "$text, $actionLabel"
            stateDescription = if (expanded) expandedLabel else collapsedLabel
        },
        shape = RoundedCornerShape(8.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
    ) {
        FlowRow(Modifier.padding(horizontal = 10.dp, vertical = 5.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(text, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (peak) Text(badge, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
        }
    }
}

private fun multiplierText(multiplier: Double): String =
    if (multiplier == multiplier.toLong().toDouble()) multiplier.toLong().toString() else fixed(multiplier, 1)
