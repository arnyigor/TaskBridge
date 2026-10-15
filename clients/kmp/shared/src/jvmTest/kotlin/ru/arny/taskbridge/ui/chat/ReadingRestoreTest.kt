package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// Баг 2026-10-14: «при получении контента всё равно скроллится». Лента с
// reverseLayout держит нижний (растущий) элемент как якорь, поэтому во время
// чтения выше низа растущий ответ толкал вид. Возврат к позиции чтения разрешён
// только в узком наборе случаев — их и проверяем.
class ReadingRestoreTest {

    @Test
    fun whileTheUserIsAtTheBottomNothingIsRestored() {
        // Следуя за новым, низ держит сама лента: возврат только мешал бы.
        assertFalse(needsReadingRestore(following = true, scrolling = false, currentIndex = 0, currentOffset = 0, targetIndex = 3, targetOffset = 120))
    }

    @Test
    fun duringTheUsersOwnDragNothingIsRestored() {
        // Скролл поверх жеста — это тот самый «лишний скролл», от которого уходим.
        assertFalse(needsReadingRestore(following = false, scrolling = true, currentIndex = 5, currentOffset = 10, targetIndex = 3, targetOffset = 40))
    }

    @Test
    fun anUnknownAnchorIsNotARestore() {
        assertFalse(needsReadingRestore(following = false, scrolling = false, currentIndex = 2, currentOffset = 5, targetIndex = -1, targetOffset = 5))
    }

    @Test
    fun anAlreadyCorrectPositionIsNotRestored() {
        // Каждый дельта-чанк вызывает проверку: работа без расхождения — это дёрганье ленты.
        assertFalse(needsReadingRestore(following = false, scrolling = false, currentIndex = 3, currentOffset = 40, targetIndex = 3, targetOffset = 40))
    }

    @Test
    fun aReadingPositionThatDriftedIsRestored() {
        assertTrue(needsReadingRestore(following = false, scrolling = false, currentIndex = 4, currentOffset = 40, targetIndex = 3, targetOffset = 40))
        assertTrue(needsReadingRestore(following = false, scrolling = false, currentIndex = 3, currentOffset = 96, targetIndex = 3, targetOffset = 40))
    }
}
