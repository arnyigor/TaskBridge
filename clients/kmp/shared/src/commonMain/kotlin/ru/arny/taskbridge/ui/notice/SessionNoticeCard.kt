package ru.arny.taskbridge.ui.notice

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import ru.arny.taskbridge.alertTitle
import ru.arny.taskbridge.core.client.sessions.SessionAlert

/** Сколько карточек показываем сразу: остальные новости ждут в списке сессий. */
const val SESSION_NOTICE_LIMIT = 3

/** По этому тегу клик по карточке проверяется тестом. */
const val SESSION_NOTICE_TAG = "session-notice"

/** Сколько строк текста влезает в строку карточки при её ширине и увеличенном шрифте. */
private const val NOTICE_CHARS_PER_LINE = 46
private const val NOTICE_MAX_TEXT_LINES = 4

/** Высота строки заголовка и текста: по ним считается высота карточки. */
private val TITLE_LINE = 24.dp
private val TEXT_LINE = 20.dp

/**
 * Новое уведомление заменяет прежнее по той же сессии и не вытесняет чужие:
 * оператор видит последнюю новость каждой сессии, а не последнюю вообще.
 */
fun noticesAfter(current: List<SessionAlert>, incoming: SessionAlert): List<SessionAlert> =
    (current.filterNot { it.taskId == incoming.taskId } + incoming).takeLast(SESSION_NOTICE_LIMIT)

/** Сколько строк займёт заголовок и текст: по ним считается высота карточки. */
internal fun noticeTitleLines(title: String): Int = if (title.length > NOTICE_CHARS_PER_LINE) 2 else 1

internal fun noticeTextLines(text: String): Int =
    ((text.length + NOTICE_CHARS_PER_LINE - 1) / NOTICE_CHARS_PER_LINE).coerceIn(1, NOTICE_MAX_TEXT_LINES)

/**
 * Высота карточки по содержимому. Окну нужен точный размер: прозрачная область
 * вокруг карточки перехватывала бы клики по чужим окнам, поэтому «на всякий
 * случай побольше» здесь нельзя.
 */
fun noticeHeight(title: String, text: String): Dp =
    20.dp + TITLE_LINE * noticeTitleLines(title) + 4.dp + TEXT_LINE * noticeTextLines(text)

/**
 * Карточка уведомления о сессии. В отличие от системного тоста её можно нажать —
 * клик открывает чат этой сессии. Верхняя строка начинается с проекта: по одной
 * сессии не видно, чья она. Фон — `inverseSurface`: тёмный на светлой теме и
 * светлый на тёмной, поэтому карточка всегда отличается от окна под ней, как
 * системное уведомление, и текст на ней читается в любой теме.
 */
@Composable
fun SessionNoticeCard(alert: SessionAlert, onOpen: (String) -> Unit, modifier: Modifier = Modifier) {
    val title = alertTitle(alert)
    Surface(
        modifier = modifier.fillMaxWidth().testTag(SESSION_NOTICE_TAG).clickable { onOpen(alert.taskId) },
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.inverseSurface,
        shadowElevation = 6.dp,
    ) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Text(
                title,
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.inverseOnSurface,
                maxLines = noticeTitleLines(title),
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                alert.text,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.inverseOnSurface.copy(alpha = 0.78f),
                maxLines = noticeTextLines(alert.text),
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
