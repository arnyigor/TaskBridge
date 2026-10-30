package ru.arny.taskbridge.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ru.arny.taskbridge.core.client.chat.ChatItem
import ru.arny.taskbridge.ui.theme.AppIcons

/**
 * Поиск по открытой сессии: запрос ищется в текстах сообщений загруженной истории,
 * найденное подсвечивается в ленте, а стрелки водят между совпадениями.
 *
 * Логика отделена от разметки: что найдено и куда прокрутить — чистые функции,
 * проверяемые без устройства (ChatSearchTest); здесь же только показ.
 */

/**
 * Одно совпадение — одно сообщение ленты. Диапазон — первое вхождение в его
 * тексте (по нему лента доводится до места), [occurrences] — сколько всего
 * вхождений в этом сообщении.
 *
 * Почему уровень сообщения, а не каждого вхождения: переход по стрелкам должен
 * быть виден. Подсветка рисуется по размеченному тексту блока (абзаца, ячейки), а
 * смещения в исходном Markdown к нему не сводятся, — отдельное вхождение внутри
 * одного ответа выделить нечем, и переход между такими «вариантами» выглядел
 * как «ничего не произошло» (жалоба оператора 2026-10-30).
 */
internal data class ChatSearchHit(
    val itemId: String,
    val range: IntRange,
    val inTool: Boolean = false,
    val occurrences: Int = 1,
)

/** Куда ведёт переход: индекс сообщения в перевёрнутой ленте. */
internal data class SearchTarget(val index: Int)

/** Что подсвечивать в ленте; пустой запрос — поиск закрыт, подсветки нет. */
internal data class ChatSearchHighlight(val query: String = "", val activeItemId: String? = null, val step: Int = 0)

/** Сообщение, которое сейчас рисуется (задаётся лентой на каждый элемент). */
internal val LocalSearchItemId = compositionLocalOf { "" }

/** Действующий поиск: запрос и сообщение, к которому сейчас ведёт переход. */
internal val LocalChatSearch = compositionLocalOf { ChatSearchHighlight() }

/**
 * Кто первый нашёл совпадение в сообщении — тот и доводит его до экрана.
 *
 * Почему не прокрутка по доле текста: высота сообщения складывается из размышлений,
 * строк инструментов и разметки ответа, и доля текста не равна доле высоты. Реальный
 * случай 2026-10-30: счётчик «2 из 2», а на экране — размышления и строки
 * инструментов без единой подсветки. Поэтому место находки знает сам блок с
 * подсветкой, а его доводит до экрана [Modifier.searchBringIntoView].
 */
internal class SearchBringIntoView {
    private var claimed: String? = null

    /** true — этот блок первым взялся довести текущее совпадение до экрана. */
    fun claim(signature: String): Boolean {
        if (claimed == signature) return false
        claimed = signature
        return true
    }
}

/** Держатель на каждое сообщение ленты (свой на элемент, см. [LocalSearchItemId]). */
internal val LocalSearchBringIntoView = compositionLocalOf<SearchBringIntoView?> { null }

/** Текст сообщения, по которому идёт поиск: ровно то, что видно в ленте. */
internal fun ChatItem.searchText(): String = when (this) {
    is ChatItem.User -> text
    is ChatItem.Assistant -> text
    is ChatItem.Note -> text
}

/**
 * Тексты строк инструментов: имя вызова и путь/команда. Ищутся они потому, что
 * видны в ленте («Выполнил: npm test»), а полного вывода инструмента в клиенте нет
 * вовсе — он запрашивается по нажатию, искать в нём нечего.
 */
internal fun ChatItem.toolTexts(): List<String> = when (this) {
    // distinct: у файловых инструментов подпись и путь часто одна и та же строка —
    // иначе одно и то же вхождение считалось бы дважды (счётчик и переходы).
    is ChatItem.Assistant -> tools.flatMap { tool -> listOfNotNull(tool.label, tool.path) }.filter { it.isNotBlank() }.distinct()
    else -> emptyList()
}

/**
 * Совпадения по загруженной истории: от старых к новым, по одному на сообщение.
 * Регистр не важен, но длина текста не меняется: регистронезависимый поиск идёт
 * посимвольным сравнением (см. [matchRanges]), иначе подсветка уехала бы на
 * символах вроде «İ», которые при приведении регистра меняют длину.
 */
internal fun chatSearchHits(items: List<ChatItem>, query: String): List<ChatSearchHit> {
    val needle = query.trim()
    if (needle.isEmpty()) return emptyList()
    val hits = ArrayList<ChatSearchHit>()
    for (item in items) {
        val ranges = matchRanges(item.searchText(), needle)
        // Строки инструментов: то, что видно как «Выполнил: npm test».
        val toolRanges = item.toolTexts().flatMap { matchRanges(it, needle) }
        val all = ranges.size + toolRanges.size
        if (all == 0) continue
        val first = ranges.firstOrNull()
        hits += if (first != null) {
            ChatSearchHit(item.id, first, occurrences = all)
        } else {
            // Совпадение только в строке инструмента: она стоит НАД текстом ответа,
            // и переход ставит ленту на начало сообщения (см. [searchTarget]).
            ChatSearchHit(item.id, toolRanges.first(), inTool = true, occurrences = all)
        }
    }
    return hits
}

/** Диапазоны вхождений [needle] в [text] без учёта регистра; вхождения не перекрываются. */
internal fun matchRanges(text: String, needle: String): List<IntRange> {
    if (needle.isEmpty() || text.length < needle.length) return emptyList()
    val ranges = ArrayList<IntRange>()
    var from = 0
    while (from <= text.length - needle.length) {
        val at = text.indexOf(needle, from, ignoreCase = true)
        if (at < 0) break
        ranges += at until (at + needle.length)
        from = at + needle.length
    }
    return ranges
}

/**
 * Куда прокрутить ленту для совпадения. Лента чата перевёрнута (`reverseLayout`),
 * поэтому индекс считается от конца истории. Совпадение внутри длинного сообщения
 * адресуется долей его текста: точную строку у ленты не спросить, а высота элемента
 * складывается из разметки, инструментов и размышлений.
 */
internal fun searchTarget(items: List<ChatItem>, hit: ChatSearchHit): SearchTarget? {
    val position = items.indexOfFirst { it.id == hit.itemId }
    if (position < 0) return null
    return SearchTarget(index = items.size - 1 - position)
}

/**
 * Прокрутка к найденному сообщению. Место находки внутри него доводит до экрана
 * сам блок с подсветкой: у ленты нет способа узнать, где в сообщении лежит строка
 * с совпадением, а оценка по доле текста врёт тем сильнее, чем больше в сообщении
 * размышлений и строк инструментов.
 *
 * Сообщение, которое уже видно, не трогаем: иначе прокрутка спорила бы с
 * `bringIntoView` блока и возвращала ленту к началу сообщения.
 */
internal suspend fun revealSearchHit(listState: LazyListState, target: SearchTarget) {
    if (listState.layoutInfo.visibleItemsInfo.any { it.index == target.index }) return
    listState.scrollToItem(target.index)
}

/** Счётчик совпадений для строки поиска: «3 из 12» — сообщения с находками. */
internal fun searchStatusLabel(matches: Int, current: Int, query: String): String = when {
    query.isBlank() -> ""
    matches <= 0 -> "0 из 0"
    else -> "${(current + 1).coerceIn(1, matches)} из $matches"
}

/** Следующее совпадение по кругу: с последнего «вперёд» ведёт к первому и наоборот. */
internal fun stepSearchIndex(current: Int, delta: Int, count: Int): Int =
    if (count <= 0) -1 else (current + delta).mod(count)

/**
 * Подсветка найденного в готовом тексте: фон под каждым вхождением. Совпадения
 * ведущего сообщения получают сильный цвет — по нему видно, к какому из них
 * привёл переход, когда в ленте подсвечено несколько сообщений сразу.
 */
internal fun AnnotatedString.markSearch(query: String, color: Color): AnnotatedString {
    val ranges = matchRanges(text, query)
    if (ranges.isEmpty()) return this
    val style = SpanStyle(background = color)
    return buildAnnotatedString {
        append(this@markSearch)
        for (range in ranges) addStyle(style, range.first, range.last + 1)
    }
}

/** Подсветка найденного в тексте сообщения (см. [LocalSearchItemId]). */
@Composable
internal fun searchHighlighted(text: String): AnnotatedString =
    searchHighlighted(AnnotatedString(text))

/** Подсветка найденного в размеченном тексте: ссылки и начертания сохраняются. */
@Composable
internal fun searchHighlighted(text: AnnotatedString): AnnotatedString {
    val search = LocalChatSearch.current
    val query = search.query
    if (query.isBlank()) return text
    val active = LocalSearchItemId.current.let { it.isNotEmpty() && it == search.activeItemId }
    // Разница между ведущим и остальными совпадениями должна читаться глазом: при
    // близких оттенках переход по стрелкам выглядел как «ничего не произошло» (2026-10-30).
    val color = if (active) MaterialTheme.colorScheme.primary.copy(alpha = 0.6f) else MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)
    return remember(text, query, color) { text.markSearch(query, color) }
}

/**
 * Доводит блок с найденным до экрана: первый такой блок ведущего сообщения
 * прокручивает ленту ровно к себе. Ключ включает [ChatSearchHighlight.step],
 * иначе возврат к уже просмотренному сообщению не прокручивал бы ничего.
 */
@Composable
internal fun Modifier.searchBringIntoView(text: String): Modifier {
    val search = LocalChatSearch.current
    val claim = LocalSearchBringIntoView.current
    val itemId = LocalSearchItemId.current
    if (claim == null || search.query.isBlank() || itemId.isEmpty() || itemId != search.activeItemId) return this
    val found = remember(text, search.query) { matchRanges(text, search.query).isNotEmpty() }
    if (!found) return this
    val requester = remember { BringIntoViewRequester() }
    val signature = "${search.query}|$itemId|${search.step}"
    LaunchedEffect(signature) { if (claim.claim(signature)) requester.bringIntoView() }
    return bringIntoViewRequester(requester)
}

/**
 * Строка поиска над лентой: поле с автофокусом, счётчик, переход по совпадениям и
 * закрытие. Enter ведёт к следующему совпадению, Esc закрывает поиск — как в
 * браузере, где такой строкой и ищут.
 */
@Composable
internal fun ChatSearchBar(
    query: String,
    onQuery: (String) -> Unit,
    matches: Int,
    current: Int,
    partialHistory: Boolean,
    onStep: (Int) -> Unit,
    onClose: () -> Unit,
) {
    val focus = remember { FocusRequester() }
    // Колбэки читаются через rememberUpdatedState: лямбды внутри IconButton Compose
    // мемоизирует, и первый захваченный onStep оставался навсегда. Стрелки считали шаг
    // от состояния, где находок ещё не было (hits = 0), и молча ничего не делали —
    // «кликаешь на стрелки и ничего» (оператор, десктоп, 2026-10-30).
    val step by rememberUpdatedState(onStep)
    val close by rememberUpdatedState(onClose)
    val query_ by rememberUpdatedState(onQuery)
    // Панель появляется по нажатию «Поиск»: без автофокуса первым делом нужно было бы
    // ещё раз попасть в поле, а на телефоне — ещё и открыть клавиатуру.
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Row(
            Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            OutlinedTextField(
                value = query,
                onValueChange = { query_(it) },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium,
                // Подсказка в поле говорит, по чему идёт поиск: история листается
                // страницами, и «вся сессия» — обещание, которого лента не выполняет.
                placeholder = {
                    Text(
                        if (partialHistory) "Поиск по загруженной истории" else "Найти в сессии",
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                modifier = Modifier
                    .weight(1f)
                    .focusRequester(focus)
                    .onPreviewKeyEvent { event ->
                        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                        when (event.key) {
                            // Стрелки — тот же переход, что кнопками: искать и листать
                            // найденное удобнее с клавиатуры, и раньше они двигали только каретку.
                            Key.Enter, Key.NumPadEnter, Key.DirectionDown -> { step(1); true }
                            Key.DirectionUp -> { step(-1); true }
                            Key.Escape -> { close(); true }
                            else -> false
                        }
                    },
            )
            Text(
                searchStatusLabel(matches, current, query),
                style = MaterialTheme.typography.labelMedium,
                color = muted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 96.dp),
            )
            // Нажатие на стрелку уводит фокус из поля, и следующая набранная буква
            // уходила бы в никуда — поэтому фокус возвращается в поле сразу.
            IconButton(onClick = { step(-1); focus.requestFocus() }, enabled = matches > 0) {
                Icon(AppIcons.ChevronUp, "Предыдущее совпадение", Modifier.size(18.dp), tint = muted)
            }
            IconButton(onClick = { step(1); focus.requestFocus() }, enabled = matches > 0) {
                Icon(AppIcons.ChevronDown, "Следующее совпадение", Modifier.size(18.dp), tint = muted)
            }
            IconButton(onClick = { close() }) {
                Icon(AppIcons.Close, "Закрыть поиск", Modifier.size(18.dp), tint = muted)
            }
        }
    }
}
