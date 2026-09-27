package ru.arny.taskbridge.platform

import java.util.UUID
import java.util.prefs.Preferences
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class DpapiSecretStoreTest {
    @Test
    fun roundTripsWithCurrentWindowsUserKey() {
        if (!System.getProperty("os.name").startsWith("Windows", ignoreCase = true)) return
        val node = Preferences.userRoot().node("ru/arny/taskbridge/test-${UUID.randomUUID()}")
        try {
            val secrets = DpapiSecretStore(node)
            secrets.put("token", "sensitive-test-value")
            assertEquals("sensitive-test-value", secrets.get("token"))
            secrets.put("token", null)
            assertNull(secrets.get("token"))
        } finally {
            runCatching { node.removeNode() }
        }
    }
}
