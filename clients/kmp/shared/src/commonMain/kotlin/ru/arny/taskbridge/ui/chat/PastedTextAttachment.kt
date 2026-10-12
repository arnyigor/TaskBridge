package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.UploadFile

internal const val PASTED_TEXT_FILE_THRESHOLD = 8000

internal data class LargeTextAttachment(
    val text: String,
    val remainingText: String,
    val caret: Int,
)

/**
 * Поле ввода после вставки.
 *
 * Один разбор на оба поля — в чате и в черновике нового сообщения. Черновик
 * разбирал вставку иначе, и большой текст, вставленный первым сообщением,
 * оставался стеной в поле вместо вложения (наблюдение оператора 2026-10-12).
 *
 * [caret] == null — вставка осталась текстом: значение поля берётся у самого поля,
 * и каретка не переставляется.
 */
internal data class PastedTextDraft(
    val text: String,
    val caret: Int?,
    val attached: UploadFile?,
)

/** Разбирает вставку: большой текст уезжает файлом, остаток остаётся в поле. */
internal fun pastedTextDraft(previousText: String, nextText: String, nowIso: String): PastedTextDraft {
    val attachment = largeTextAttachmentFromDraftChange(previousText, nextText)
        ?: return PastedTextDraft(nextText, null, null)
    return PastedTextDraft(
        text = attachment.remainingText,
        caret = attachment.caret.coerceIn(0, attachment.remainingText.length),
        attached = UploadFile(pastedTextFileName(nowIso), "text/plain", attachment.text.encodeToByteArray()),
    )
}

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
