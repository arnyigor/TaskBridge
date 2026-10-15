package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.api.Project
import ru.arny.taskbridge.core.api.Task
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Путь проекта в шапке чата.
 *
 * Оператор: «в чат рядом с названием добавить путь к проекту» — на телефоне из
 * заголовка не было видно, к какой папке относится открытый чат. Проверяется
 * резолв projectId → path (рендер строки требует устройства).
 */
class ProjectPathTest {
    private fun project(id: String, path: String?) = Project(id = id, name = id, path = path)

    @Test
    fun `resolves the path of the task's project`() {
        val task = Task(id = "t1", projectId = "p2")
        val projects = listOf(project("p1", "C:\\one"), project("p2", "G:\\Android\\Taskbridge"))
        assertEquals("G:\\Android\\Taskbridge", projectPathFor(task, projects))
    }

    @Test
    fun `no path when the project is missing from the list`() {
        assertNull(projectPathFor(Task(id = "t1", projectId = "gone"), listOf(project("p1", "C:\\one"))))
    }

    @Test
    fun `no path for a project without a path and for a taskless screen`() {
        assertNull(projectPathFor(Task(id = "t1", projectId = "p1"), listOf(project("p1", null))))
        assertNull(projectPathFor(Task(id = "t1", projectId = "p1"), listOf(project("p1", "  "))))
        assertNull(projectPathFor(Task(id = "t1", projectId = null), listOf(project("p1", "C:\\one"))))
        assertNull(projectPathFor(null, listOf(project("p1", "C:\\one"))))
    }
}
