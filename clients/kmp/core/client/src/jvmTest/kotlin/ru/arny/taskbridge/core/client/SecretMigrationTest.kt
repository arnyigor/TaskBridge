package ru.arny.taskbridge.core.client

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import ru.arny.taskbridge.core.client.settings.AppSettings
import ru.arny.taskbridge.core.client.settings.KeyValueStore
import ru.arny.taskbridge.core.client.settings.SecretStore

class SecretMigrationTest {
    @Test
    fun legacyCredentialsMoveToProtectedStoreOnFirstRead() {
        val regular = MemoryStore(mutableMapOf("authToken" to "legacy-token", "sessionCookie" to "legacy-cookie"))
        val protected = MemoryStore()
        val settings = AppSettings(regular, { "id" }, "desktop", protected)

        assertEquals("legacy-token", settings.authToken)
        assertEquals("legacy-cookie", settings.sessionCookie)
        assertNull(regular.get("authToken"))
        assertNull(regular.get("sessionCookie"))
        assertEquals("legacy-token", protected.get("authToken"))
        assertEquals("legacy-cookie", protected.get("sessionCookie"))
    }

    private class MemoryStore(private val values: MutableMap<String, String> = mutableMapOf()) : KeyValueStore, SecretStore {
        override fun get(key: String): String? = values[key]
        override fun put(key: String, value: String?) { if (value == null) values.remove(key) else values[key] = value }
    }
}
