package ru.arny.taskbridge.ui.chat

internal const val PASTED_TEXT_FILE_THRESHOLD = 8000

internal data class LargeTextAttachment(
    val text: String,
    val remainingText: String,
    val caret: Int,
)

/**
 * Mirrors the web composer: text that would turn the prompt into a wall of text
 * is sent as a .txt attachment instead of staying in the input field.
 */
internal fun largeTextAttachmentFromDraftChange(
    previousText: String,
    nextText: String,
    threshold: Int = PASTED_TEXT_FILE_THRESHOLD,
): LargeTextAttachment? {
    if (nextText.length <= threshold) return null

    val prefix = commonPrefixLength(previousText, nextText)
    val suffix = commonSuffixLength(previousText, nextText, prefix)
    val insertedEnd = nextText.length - suffix
    val insertedText = nextText.substring(prefix, insertedEnd)

    return if (insertedText.length > threshold) {
        LargeTextAttachment(
            text = insertedText,
            remainingText = nextText.removeRange(prefix, insertedEnd),
            caret = prefix,
        )
    } else {
        LargeTextAttachment(text = nextText, remainingText = "", caret = 0)
    }
}

internal fun pastedTextFileName(nowIso: String): String =
    "pasted-${nowIso.replace(':', '-').replace('.', '-')}.txt"

private fun commonPrefixLength(a: String, b: String): Int {
    val limit = minOf(a.length, b.length)
    var index = 0
    while (index < limit && a[index] == b[index]) index++
    return index
}

private fun commonSuffixLength(a: String, b: String, prefix: Int): Int {
    val max = minOf(a.length, b.length) - prefix
    var count = 0
    while (count < max && a[a.lastIndex - count] == b[b.lastIndex - count]) count++
    return count
}
