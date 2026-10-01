package ru.arny.taskbridge.ui.sessions

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Клик по заголовку — единственный способ сложить папку сессий. Пока непрочитанное
 * уведомление перебивало выбор оператора, папка с новостью не закрывалась вовсе:
 * клик менял сохранённое значение, но на экране не происходило ничего.
 */
class FolderExpansionTest {
    @Test
    fun foldedByHandFolderWithNewsStaysFolded() {
        assertFalse(
            folderExpanded(handExpanded = false, alerted = true, autoOpen = true),
            "клик оператора обязан складывать папку, даже если внутри ждёт непрочитанное уведомление",
        )
    }

    @Test
    fun openedByHandFolderStaysOpen() {
        assertTrue(
            folderExpanded(handExpanded = true, alerted = false, autoOpen = false),
            "развёрнутая вручную папка не должна закрываться сама",
        )
    }

    @Test
    fun untouchedFolderWithNewsOpens() {
        assertTrue(
            folderExpanded(handExpanded = null, alerted = true, autoOpen = false),
            "новость не должна прятаться в папке, которую оператор не трогал",
        )
    }

    @Test
    fun untouchedQuietFolderFollowsDefault() {
        assertTrue(folderExpanded(handExpanded = null, alerted = false, autoOpen = true))
        assertFalse(folderExpanded(handExpanded = null, alerted = false, autoOpen = false))
    }

    @Test
    fun handChoiceBeatsAutoOpen() {
        assertFalse(
            folderExpanded(handExpanded = false, alerted = false, autoOpen = true),
            "активная сессия внутри не должна разворачивать сложенную вручную папку",
        )
    }
}
