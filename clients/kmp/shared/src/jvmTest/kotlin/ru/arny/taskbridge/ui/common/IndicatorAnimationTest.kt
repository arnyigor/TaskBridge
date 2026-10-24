package ru.arny.taskbridge.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.ui.ImageComposeScene
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toComposeImageBitmap
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import ru.arny.taskbridge.core.client.sessions.DisplayState
import ru.arny.taskbridge.ui.sessions.attentionPulse
import ru.arny.taskbridge.ui.theme.TaskBridgeTheme
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.DurationUnit
import kotlin.time.toDuration

/**
 * Индикаторы не должны рисоваться вечно.
 *
 * Бесконечная анимация точки статуса означала, что приложение перерисовывает всё окно
 * 60 раз в секунду, пока в списке есть работающая сессия, — даже если оператор ничего
 * не делает. Проверка по кадрам: сцена рендерится во времени, и после короткой вспышки
 * она больше не просит новый кадр (`hasInvalidations`).
 */
class IndicatorAnimationTest {

    private fun scene(content: @androidx.compose.runtime.Composable () -> Unit): ImageComposeScene =
        ImageComposeScene(width = 160, height = 40, density = Density(1f)) {
            TaskBridgeTheme(mode = "light") { content() }
        }

    private fun ImageComposeScene.renderAt(millis: Long) {
        render(millis.toDuration(DurationUnit.MILLISECONDS))
    }

    /** Сколько раз картинка изменилась за [windowMillis] реального времени (шаг кадров — 16 мс). */
    private fun ImageComposeScene.pictureChanges(windowMillis: Long): Int {
        var previous: List<Long>? = null
        var changes = 0
        var millis = 0L
        val until = System.currentTimeMillis() + windowMillis
        while (System.currentTimeMillis() < until) {
            val frame = render(millis.toDuration(DurationUnit.MILLISECONDS)).toComposeImageBitmap().toPixelMap()
            val sample = ArrayList<Long>(frame.width * frame.height / 16 + 1)
            for (y in 0 until frame.height step 4) {
                for (x in 0 until frame.width step 4) sample.add(frame[x, y].value.toLong())
            }
            if (previous != null && previous != sample) changes++
            previous = sample
            millis += 16L
            Thread.sleep(16)
        }
        return changes
    }

    @Test
    fun workingIndicatorsAreStillInsteadOfRepaintingForever() {
        val scene = scene {
            Row {
                StatusDot(DisplayState.WORKING)
                StatusPill(DisplayState.WORKING)
                StatusDot(DisplayState.WAITING_USER)
            }
        }
        try {
            scene.renderAt(0)
            assertFalse(
                scene.hasInvalidations(),
                "точка статуса не анимируется: работающая сессия — это цвет, а не бесконечная перерисовка",
            )
            scene.renderAt(5_000)
            assertFalse(scene.hasInvalidations(), "кадр после простоя не должен запрашивать следующий")
        } finally {
            scene.close()
        }
    }

    @Test
    fun attentionFlashPlaysAndThenStops() {
        var values = 0
        var last = -1f
        val scene = scene {
            val pulse = attentionPulse(attention = true)
            if (pulse != last) {
                last = pulse
                values += 1
            }
            Box(Modifier.size(20.dp).alpha(0.2f + 0.8f * pulse).background(Color.Red))
        }
        try {
            // Кадры идут как на экране — каждые 16 мс: анимация в Compose считается по их времени.
            var millis = 0L
            var runningAfterSecond = true
            while (millis <= 3_000L) {
                scene.renderAt(millis)
                if (millis == 1_000L) runningAfterSecond = scene.hasInvalidations()
                millis += 16L
            }
            assertTrue(runningAfterSecond, "вспышка длится около двух секунд, а не один кадр")
            assertTrue(values > 1, "подсветка обязана меняться по кадрам: $values значений")
            assertFalse(scene.hasInvalidations(), "после двух волн подсветка замирает и экран больше не перерисовывается")
            scene.renderAt(10_000)
            assertFalse(scene.hasInvalidations(), "и не просыпается позже: непрочитанное остаётся подсвеченным")
        } finally {
            scene.close()
        }
    }

    @Test
    fun aRowWithoutNewsDoesNotAnimate() {
        val scene = scene {
            val pulse = attentionPulse(attention = false)
            Box(Modifier.size(20.dp).alpha(0.2f + 0.8f * pulse).background(Color.Red))
        }
        try {
            scene.renderAt(0)
            assertFalse(scene.hasInvalidations(), "без уведомления подсветка просто стоит")
        } finally {
            scene.close()
        }
    }

    /**
     * Точки «агент пишет» без генерации не рисуются вовсе: провайдер фаз с active = false
     * не запускает таймер, поэтому ни одного лишнего кадра.
     */
    @Test
    fun typingIndicatorInIdleRequestsNoFrames() {
        val scene = scene { TypingPhase(active = false) { TypingIndicator() } }
        try {
            for (millis in 0L..1_000L step 16L) {
                scene.renderAt(millis)
                assertFalse(scene.hasInvalidations(), "без генерации точек нечего перерисовывать ($millis мс)")
            }
            assertEquals(0, scene.pictureChanges(windowMillis = 300), "и картинка не меняется")
        } finally {
            scene.close()
        }
    }

    /**
     * Во время генерации точки меняют фазу шагами, а не каждый кадр: при шаге
     * [TYPING_STEP_MILLIS] = 280 мс картинка меняется около 3.6 раз в секунду — по одному
     * на шаг, а не 60. Быстрее прежнего порога (7 шагов/с до FP-UX-05-правки) быть не должно.
     */
    @Test
    fun typingIndicatorStepsInsteadOfSixtyFramesPerSecond() {
        val scene = scene { TypingPhase(active = true) { TypingIndicator() } }
        try {
            val changes = scene.pictureChanges(windowMillis = 1_000)
            assertTrue(changes in 2..5, "шагов в секунду должно быть около 3–4 (не более 5), а было $changes")
        } finally {
            scene.close()
        }
    }
}
