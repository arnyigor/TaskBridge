package ru.arny.taskbridge.ui.sessions

import androidx.compose.ui.ImageComposeScene
import androidx.compose.ui.unit.Density
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Мигание строки, из которой прилетело уведомление, — единственная замена
 * прыжку на чужой чат. Значит оно обязано реально идти: постоянная подсветка
 * не отличит свежую новость от прочитанной, а нулевая — не подсветит ничего.
 * Сцена рендерится вручную, поэтому фаза анимации задаётся временем кадра.
 */
class AttentionPulseTest {
    private fun pulseFrames(attention: Boolean, frameNanos: List<Long>): List<Float> {
        val values = mutableListOf<Float>()
        val scene = ImageComposeScene(width = 200, height = 40, density = Density(1f)) {
            values += attentionPulse(attention = attention)
        }
        try {
            frameNanos.forEach { scene.render(it) }
        } finally {
            scene.close()
        }
        return values
    }

    @Test
    fun anAlertedRowGoesBrightAndDim() {
        val values = pulseFrames(attention = true, frameNanos = listOf(0L, 175_000_000L, 350_000_000L, 700_000_000L))
        assertTrue(values.isNotEmpty(), "the pulse must be read at least once")
        assertTrue(values.all { it in 0f..1f }, "the pulse is an alpha: $values")
        assertTrue(values.distinct().size > 1, "a constant light is not a pulse: $values")
    }

    @Test
    fun aRowWithoutNewsIsNotLit() {
        // Одно значение на все кадры: строка без новостей не светится и не перерисовывается
        // каждые 700 мс — анимация включается только у строки с уведомлением.
        val values = pulseFrames(attention = false, frameNanos = listOf(0L, 350_000_000L, 700_000_000L))
        assertTrue(values.isNotEmpty(), "the pulse must be read at least once")
        assertEquals(listOf(0f), values.distinct(), "a row without news must stay dark and still")
    }
}
