package ru.arny.taskbridge.ui.mcp

import ru.arny.taskbridge.core.api.McpCollision
import ru.arny.taskbridge.core.api.McpHealth
import ru.arny.taskbridge.core.api.McpServer
import ru.arny.taskbridge.core.api.McpStatus
import kotlin.test.Test
import kotlin.test.assertEquals

// Сводка MCP в «Настройках» — единственное, что видно до перехода на экран
// серверов. Если она врёт про режим или прячет ошибку, человек не заходит туда,
// где проблема и лежит.

class McpSummaryTest {

    private fun server(name: String, disabled: Boolean = false, state: String? = null) = McpServer(
        name = name,
        disabled = disabled,
        health = state?.let { McpHealth(state = it) },
    )

    @Test
    fun noStatusIsAnExplicitUnknown() {
        assertEquals("нет данных", mcpSummary(null))
    }

    @Test
    fun modeIsNamedTheSameWayAsTheChips() {
        assertEquals("Из Pi", mcpModeLabel("inherit"))
        assertEquals("Управляемый", mcpModeLabel("managed"))
        assertEquals("Выключен", mcpModeLabel("off"))
        assertEquals("нет данных", mcpModeLabel(null))
    }

    @Test
    fun chipsAndSummaryUseOneListOfModes() {
        // Чипы в «Настройках» и на экране MCP берут подписи отсюда: копия списка
        // в двух файлах рано или поздно назвала бы один режим по-разному.
        assertEquals(listOf("inherit", "managed", "off"), mcpModes.map { it.first })
        assertEquals("нет данных", mcpModeLabel("unknown-mode"))
    }

    @Test
    fun summaryCountsOnlyEnabledServers() {
        val status = McpStatus(
            mode = "inherit",
            servers = listOf(server("fs"), server("git", disabled = true)),
        )
        assertEquals("Из Pi · серверов: 1", mcpSummary(status))
    }

    @Test
    fun summaryNamesBrokenServersAndCollisions() {
        val status = McpStatus(
            mode = "managed",
            servers = listOf(server("fs", state = "ok"), server("git", state = "error"), server("off", disabled = true, state = "error")),
            collisions = listOf(McpCollision(tool = "read_file", servers = listOf("fs", "git"))),
        )
        // Выключенный сервер с ошибкой — не «сервер с ошибкой»: он не работает намеренно.
        assertEquals("Управляемый · серверов: 2 · с ошибкой: 1 · конфликтов: 1", mcpSummary(status))
    }

    @Test
    fun healthyStatusStaysShort() {
        val status = McpStatus(mode = "off", servers = listOf(server("fs", state = "ok")))
        assertEquals("Выключен · серверов: 1", mcpSummary(status))
    }
}
