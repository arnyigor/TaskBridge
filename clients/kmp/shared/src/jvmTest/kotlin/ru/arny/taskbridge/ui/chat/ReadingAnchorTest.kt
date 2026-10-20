package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Пункт 226 плана: «проверка поведением, а не глазами» — прокрутили вверх, пришли
 * дельты, позиция чтения не изменилась. Здесь проверяется сам якорь: он адресуется
 * ключом (индексы сдвигаются от новых сообщений и догрузки старой страницы), а
 * возврат считается только когда лента действительно уехала.
 */
class ReadingAnchorTest {

    @Test
    fun `deltas arriving do not move the reading position`() {
        val anchor = ReadingAnchor()
        // До дельт лента была ["m5", "m6", "m7"]: оператор стоит на "m7" (индекс 2).
        val before = listOf("m5", "m6", "m7")
        anchor.record(contentArrived = false, index = 2, offset = 33) { before.getOrNull(it) }
        assertEquals("m7", anchor.key, "якорь держит элемент, а не индекс")

        // Пришли дельты, и в ленту добавилось новое сообщение: у того же "m7" теперь
        // индекс 3, а лента к тому же уехала (оператор видит индекс 4).
        val after = listOf("m4", "m5", "m6", "m7")
        assertEquals(3, after.indexOf("m7"), "предусловие: индекс того же элемента изменился")

        val target = anchor.target(
            following = false,
            scrolling = false,
            currentIndex = 4,
            currentOffset = 33,
            indexOf = { id -> after.indexOf(id) },
        )
        assertEquals(3 to 33, target, "возврат — к тому же элементу (по ключу) и тому же смещению")
    }

    @Test
    fun `nothing is restored when the operator is at the bottom or scrolling`() {
        val anchor = ReadingAnchor()
        anchor.record(contentArrived = false, index = 5, offset = 33, keyOf = { "m$it" })
        val indexOf = { id: String -> listOf("m2", "m3", "m4", "m5", "m6").indexOf(id) }

        assertNull(
            anchor.target(following = true, scrolling = false, currentIndex = 0, currentOffset = 0, indexOf = indexOf),
            "оператор внизу — лента сама держит низ",
        )
        assertNull(
            anchor.target(following = false, scrolling = true, currentIndex = 6, currentOffset = 10, indexOf = indexOf),
            "палец двигает ленту — скролл поверх жеста недопустим",
        )
    }

    @Test
    fun `an anchor that vanished from the feed is not a restore target`() {
        val anchor = ReadingAnchor()
        anchor.record(contentArrived = false, index = 3, offset = 12, keyOf = { "m$it" })
        // Сообщение исчезло (сессия очищена/сжата) — возвращаться некуда.
        assertNull(anchor.target(following = false, scrolling = false, currentIndex = 4, currentOffset = 12, indexOf = { -1 }))
    }

    @Test
    fun `a position moved without content arriving is remembered`() {
        // Колесо мыши и программные переходы не поднимают `isScrollInProgress`;
        // гейт по нему (до 2026-10-17) оставлял якорь от прошлого жеста, и первая
        // же дельта возвращала ленту туда — те самые «скроллы» из жалобы оператора.
        val anchor = ReadingAnchor()
        anchor.record(contentArrived = false, index = 2, offset = 5, keyOf = { "m$it" })
        assertEquals("m2", anchor.key)
        assertNull(
            anchor.target(following = false, scrolling = false, currentIndex = 2, currentOffset = 5, indexOf = { 2 }),
            "якорь совпадает с текущей позицией — возвращать нечего",
        )
    }

    @Test
    fun `a position moved by arriving content is not remembered`() {
        // Иначе якорь запоминал бы сам сдвиг, который обязан отменить.
        val anchor = ReadingAnchor()
        anchor.record(contentArrived = false, index = 2, offset = 5, keyOf = { "m$it" })
        anchor.record(contentArrived = true, index = 4, offset = 5, keyOf = { "m$it" })
        assertEquals("m2", anchor.key, "сдвиг от контента якорь не переписывает")
        assertEquals(5, anchor.offset)
    }
}
