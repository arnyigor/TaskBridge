package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Защёлка «оператор у низа». Жалоба оператора 2026-10-17: «скролл вверх при
 * добавлении команды или элемента чата». Причина — мгновенный замер позиции:
 * новый элемент встаёт нулевым, прежний низ уезжает на индекс 1, и никем не
 * тронутая лента считается прокрученной вверх.
 */
class BottomLatchTest {

    @Test
    fun `a new element does not count as the operator scrolling away`() {
        val latch = BottomLatch()
        // Оператор у низа: 10 сообщений, лента стоит на нулевом.
        latch.observe(index = 0, offset = 0, count = 10, newestId = "m10")
        assertTrue(latch.following)

        // Пришло новое сообщение: лента держит прежний низ по ключу, его индекс стал 1.
        latch.observe(index = 1, offset = 0, count = 11, newestId = "m11")
        assertTrue(latch.following, "вставка сдвинула индекс, а не оператора")
    }

    @Test
    fun `growth of the answer does not count either`() {
        val latch = BottomLatch()
        latch.observe(index = 0, offset = 0, count = 10, newestId = "m10")
        // Дельта пришла в тот же элемент: ни число, ни ключ не изменились.
        latch.observe(index = 0, offset = 0, count = 10, newestId = "m10")
        assertTrue(latch.following)
    }

    @Test
    fun `a position moved without new content is the operator scrolling away`() {
        val latch = BottomLatch()
        latch.observe(index = 0, offset = 0, count = 10, newestId = "m10")
        // Колесо мыши: `isScrollInProgress` не поднимается, но позиция уехала.
        latch.observe(index = 0, offset = 192, count = 10, newestId = "m10")
        assertFalse(latch.following)
    }

    @Test
    fun `deletion at the bottom keeps following`() {
        val latch = BottomLatch()
        latch.observe(index = 1, offset = 40, count = 10, newestId = "m10")
        // Удаление сдвинуло индексы: позиция изменилась, а контент — тоже.
        latch.observe(index = 2, offset = 40, count = 9, newestId = "m9")
        assertTrue(latch.following)
    }

    @Test
    fun `the end of a scroll decides by where the feed stopped`() {
        val latch = BottomLatch()
        // Жест (или колесо) закончился выше низа — слежение выключено, независимо от
        // того, менялось ли в этот момент содержимое ленты.
        latch.settle(index = 4, offset = 12)
        assertFalse(latch.following)
        latch.settle(index = 0, offset = 60)
        assertTrue(latch.following)
        latch.settle(index = 0, offset = 400)
        assertFalse(latch.following)
    }

    @Test
    fun `a scroll that lands above the bottom cancels following even if the feed was re-paged`() {
        // Причина жалобы 2026-10-17 «на телефоне при получении сообщения идёт автоскролл
        // вниз»: в момент жеста прилетает переокно истории/переподключение, число
        // элементов меняется — и правило «сдвиг без прихода контента» считало это
        // приходом контента, оставляя слежение включённым. Конец прокрутки решает
        // независимо от содержимого.
        val latch = BottomLatch()
        latch.observe(index = 0, offset = 0, count = 10, newestId = "m10")
        latch.observe(index = 3, offset = 100, count = 24, newestId = "m24")
        assertTrue(latch.following, "старое правило здесь молчит — поэтому нужен settle")
        latch.settle(index = 3, offset = 100)
        assertFalse(latch.following)
    }

    @Test
    fun `returning to the bottom resumes following`() {
        val latch = BottomLatch()
        latch.observe(index = 0, offset = 0, count = 10, newestId = "m10")
        latch.observe(index = 3, offset = 10, count = 10, newestId = "m10")
        assertFalse(latch.following)
        latch.observe(index = 0, offset = 12, count = 10, newestId = "m10")
        assertTrue(latch.following, "двенадцать пикселей от низа — это всё ещё низ")
    }
}
