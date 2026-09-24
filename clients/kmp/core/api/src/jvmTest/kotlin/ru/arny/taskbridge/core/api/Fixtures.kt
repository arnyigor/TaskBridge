package ru.arny.taskbridge.core.api

import java.io.File

/** Recorded server responses (tests/fixtures/api, scripts/export-api-fixtures.mjs). */
object Fixtures {
    private val dir: File by lazy {
        val path = System.getProperty("taskbridge.fixtures") ?: error("taskbridge.fixtures is not set")
        File(path).also { require(it.isDirectory) { "no fixtures at $it" } }
    }

    fun text(name: String): String = File(dir, name).readText(Charsets.UTF_8)

    fun names(): List<String> = dir.list().orEmpty().sorted()
}
