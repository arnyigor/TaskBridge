package ru.arny.taskbridge.ui.settings

import ru.arny.taskbridge.ui.models.contextLabel
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Контекст локальной модели — шестизначное число (131072, 262144): без разрядов
 * его не прочитать, а сравнить «262144 против 131072» глазами в диалоге загрузки
 * нельзя. Разряды ставит клиент, сервер отдаёт число как есть.
 */
class ContextLabelTest {
    @Test
    fun digitsAreGroupedByThree() {
        assertEquals("4 096", contextLabel(4096))
        assertEquals("131 072", contextLabel(131072))
        assertEquals("262 144", contextLabel(262144))
        assertEquals("1 048 576", contextLabel(1048576))
        assertEquals("999", contextLabel(999))
    }
}
