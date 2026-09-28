package ru.arny.taskbridge.ui.chat

import kotlin.test.Test
import kotlin.test.assertEquals
import ru.arny.taskbridge.core.api.QuickAction

class QuickActionsTest {
    @Test
    fun slashShowsAllActions() {
        val actions = listOf(
            QuickAction("skill:test", "skill", "/skill:test", "Run test skill", "/skill:test"),
            QuickAction("prompt:fix", "prompt", "/prompt:fix", "Fix prompt", "/prompt:fix"),
        )

        assertEquals(listOf("/skill:test", "/prompt:fix"), slashQuickMatches("/", actions).map { it.title })
    }

    @Test
    fun slashFiltersByTypedQuery() {
        val actions = listOf(
            QuickAction("skill:test", "skill", "/skill:test", "Run test skill", "/skill:test"),
            QuickAction("prompt:fix", "prompt", "/prompt:fix", "Fix prompt", "/prompt:fix"),
        )

        assertEquals(listOf("/skill:test"), slashQuickMatches("/ski", actions).map { it.title })
    }
}
