package ru.arny.taskbridge.ui.chat

import java.text.NumberFormat
import java.util.Locale

internal actual fun usageInteger(value: Long, languageTag: String): String =
    NumberFormat.getIntegerInstance(Locale.forLanguageTag(languageTag)).format(value)

internal actual fun usageDecimal(value: Double, digits: Int, languageTag: String): String =
    NumberFormat.getNumberInstance(Locale.forLanguageTag(languageTag)).apply {
        minimumFractionDigits = digits
        maximumFractionDigits = digits
        isGroupingUsed = false
    }.format(value)
