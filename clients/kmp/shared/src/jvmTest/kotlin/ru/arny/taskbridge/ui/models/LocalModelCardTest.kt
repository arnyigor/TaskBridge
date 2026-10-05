package ru.arny.taskbridge.ui.models

import ru.arny.taskbridge.core.api.LocalModelEntry
import ru.arny.taskbridge.core.api.LocalVisionChange
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Строка модели на телефоне показывает состояние точкой, подписью и кнопкой —
 * если они разойдутся, «Запустить» появится у модели, которую запускать нечем.
 */
class LocalModelCardTest {
    @Test
    fun stateFollowsStatusUnlessTheFilesAreGone() {
        assertEquals(ModelState.RUNNING, modelStateOf(LocalModelEntry(id = "a", status = "loaded")))
        assertEquals(ModelState.RUNNING, modelStateOf(LocalModelEntry(id = "a", status = "sleeping")))
        assertEquals(ModelState.STARTING, modelStateOf(LocalModelEntry(id = "a", status = "loading")))
        assertEquals(ModelState.FAILED, modelStateOf(LocalModelEntry(id = "a", status = "failed")))
        assertEquals(ModelState.STOPPED, modelStateOf(LocalModelEntry(id = "a", status = "unloaded")))
        assertEquals(ModelState.STOPPED, modelStateOf(LocalModelEntry(id = "a")))
        // Веса удалили, а пресет в конфиге остался: запускать нечего, чем бы ни
        // считал себя роутер.
        assertEquals(ModelState.GONE, modelStateOf(LocalModelEntry(id = "a", status = "unloaded", filesPresent = false)))
    }

    @Test
    fun metaLineNamesTheProviderAndTheContext() {
        assertEquals("llama.cpp", modelMetaLine(LocalModelEntry(id = "a"), null))
        assertEquals("llama.cpp · контекст 262 144", modelMetaLine(LocalModelEntry(id = "a", contextWindow = 262144), null))
        assertEquals("strata · контекст 56 320", modelMetaLine(LocalModelEntry(id = "a", provider = "strata", contextWindow = 56320), "llama.cpp"))
        // Контекст из файла движка ничего не значит, когда весов на диске нет.
        assertEquals("llama.cpp", modelMetaLine(LocalModelEntry(id = "a", contextWindow = 262144, filesPresent = false), null))
    }

    @Test
    fun downloadProgressNeedsASizeFromTheServer() {
        assertNull(hfPercent(0, 0))
        assertEquals(0, hfPercent(0, 1000))
        assertEquals(45, hfPercent(450, 1000))
        assertEquals(100, hfPercent(1000, 1000))
        assertEquals(100, hfPercent(2000, 1000)) // байты догнали и перегнали округление
    }

    @Test
    fun etaIsOnlyShownWhileTheSpeedIsKnown() {
        assertNull(hfEta(1000, null))
        assertNull(hfEta(1000, 0.0))
        assertNull(hfEta(0, 1000.0))
        assertEquals("меньше минуты", hfEta(1_000, 1_000.0))
        assertEquals("12 мин", hfEta(1_000L * 60 * 12, 1_000.0))
        assertEquals("1 ч", hfEta(1_000L * 3600, 1_000.0))
        assertEquals("1 ч 5 мин", hfEta(1_000L * (3600 + 300), 1_000.0))
    }

    @Test
    fun visionNoteSaysWhatChangedAndWhenItApplies() {
        // Роутер читает models.ini при старте: без оговорки «сохранилось» читалось
        // бы как «подхватилось сейчас», а модель видит картинки только после старта.
        assertEquals(
            "Vision включён · проектор mmproj-BF16.gguf — роутер читает models.ini при старте, перезапустите его",
            visionNote(LocalVisionChange(model = "p", vision = true, previous = false, changed = true, restartRequired = true, mmproj = "G:\\m\\mmproj-BF16.gguf")),
        )
        assertEquals(
            "Vision выключен — подхватится при следующем запуске роутера",
            visionNote(LocalVisionChange(model = "p", vision = false, previous = true, changed = true)),
        )
        // Ничего не поменялось — обещать перезапуск нечего.
        assertEquals("Vision включён", visionNote(LocalVisionChange(model = "p", vision = true, previous = true, changed = false)))
        // Выключение проектор не показывает: он остался в файле, но не работает.
        assertEquals("Vision выключен", visionNote(LocalVisionChange(model = "p", vision = false, changed = false, mmproj = "G:\\m\\mmproj.gguf")))
    }
}
