package ru.arny.taskbridge.ui.chat

import ru.arny.taskbridge.core.client.chat.ToolCall
import ru.arny.taskbridge.core.client.chat.ToolState

/** What a tool call was for, so a turn reads "Изучил код · Изменил 2 файла", not a log. */
enum class ToolKind { EXPLORE, CHANGE, RUN, OTHER }

fun toolKind(name: String): ToolKind = when (name.lowercase()) {
    "read", "grep", "find", "ls", "git_ro" -> ToolKind.EXPLORE
    "edit", "write" -> ToolKind.CHANGE
    "bash" -> ToolKind.RUN
    else -> ToolKind.OTHER
}

/** Calls of one kind in a turn (an unknown tool is its own group, by name), in the order they first ran. */
data class ToolGroup(val kind: ToolKind, val name: String, val tools: List<ToolCall>) {
    val running: Boolean get() = tools.any { it.state == ToolState.RUNNING }
    val errors: Int get() = tools.count { it.state == ToolState.ERROR }
}

fun groupTools(tools: List<ToolCall>): List<ToolGroup> =
    tools.groupBy { toolKind(it.name).let { kind -> if (kind == ToolKind.OTHER) "other:${it.name}" else kind.name } }
        .values
        .map { calls -> ToolGroup(toolKind(calls.first().name), calls.first().name, calls) }

internal fun plural(n: Int, one: String, few: String, many: String) = when {
    n % 100 in 11..14 -> many
    n % 10 == 1 -> one
    n % 10 in 2..4 -> few
    else -> many
}

/** "Изучил код · 6 файлов", "Изменил 2 файла", "Выполнил 3 команды"; the present tense while it runs. */
fun groupSummary(group: ToolGroup): String {
    val n = group.tools.size
    // Files are what was read or written; a grep pattern or `git status` is not one.
    val files = group.tools.filter { it.name.lowercase() in setOf("read", "edit", "write") }.mapNotNull { toolTarget(it) }.distinct().size
    return when (group.kind) {
        ToolKind.EXPLORE -> (if (group.running) "Изучает код" else "Изучил код") +
            if (files > 0) " · $files ${plural(files, "файл", "файла", "файлов")}" else " · $n ${plural(n, "действие", "действия", "действий")}"
        ToolKind.CHANGE -> (if (group.running) "Меняет" else "Изменил") + " ${files.coerceAtLeast(1)} ${plural(files.coerceAtLeast(1), "файл", "файла", "файлов")}"
        ToolKind.RUN -> (if (group.running) "Выполняет" else "Выполнил") + " $n ${plural(n, "команду", "команды", "команд")}"
        ToolKind.OTHER -> "${group.name} · $n ${plural(n, "вызов", "вызова", "вызовов")}"
    }
}
