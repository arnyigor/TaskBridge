package ru.arny.taskbridge.platform

import java.io.File
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

class NodeCommandTest {
    private val sandboxes = mutableListOf<File>()

    private fun sandbox(): File {
        val repo = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .first { File(it, "scripts/start-lan.mjs").isFile }
        val local = File(repo, ".local").apply { mkdirs() }
        return Files.createTempDirectory(local.toPath(), "node-command-").toFile().also { sandboxes += it }
    }

    @AfterTest
    fun cleanup() { sandboxes.forEach { it.deleteRecursively() } }

    private fun dist(): File = File(sandbox(), "TaskBridge").apply {
        File(this, "server/scripts").mkdirs()
        File(this, "server/scripts/start-lan.mjs").writeText("// marker")
        File(this, "app").mkdirs()
        File(this, "TaskBridge.exe").writeText("test marker, not an executable")
    }

    private fun resolve(root: File, setting: String? = null, windows: Boolean = true, present: Set<String> = emptySet()): String {
        for (name in present) File(name).apply { parentFile.mkdirs(); writeText("test marker, not an executable") }
        return resolveNodeCommand(root, setting, { windows }, File::isFile)
    }

    @Test
    fun bundledRuntimeWinsOverPath() {
        val dist = dist()
        val node = File(dist, "runtime/node/node.exe")
        assertEquals(node.absolutePath, resolve(File(dist, "server"), present = setOf(node.absolutePath)))
    }

    @Test
    fun aRuntimeBesideTheBundledServerIsFoundToo() {
        val dist = dist()
        val node = File(dist, "server/node.exe")
        assertEquals(node.absolutePath, resolve(File(dist, "server"), present = setOf(node.absolutePath)))
    }

    @Test
    fun withoutABundledRuntimeThePathIsUsed() {
        assertEquals("node", resolve(File(dist(), "server")))
    }

    @Test
    fun theExplicitOverrideWins() {
        val dist = dist()
        val bundled = File(dist, "runtime/node/node.exe")
        val override = File(dist, "developer/node.exe").absolutePath
        assertEquals(override, resolve(File(dist, "server"), override, present = setOf(bundled.absolutePath)))
        assertEquals("node", resolve(File(dist(), "server"), "   "))
    }

    @Test
    fun aCheckoutCannotUseAnUnrelatedRuntimeInItsParent() {
        val root = File(sandbox(), "repository").apply {
            File(this, "scripts").mkdirs()
            File(this, "scripts/start-lan.mjs").writeText("// marker")
        }
        val unrelated = File(root.parentFile, "runtime/node/node.exe")
        assertEquals("node", resolve(root, present = setOf(unrelated.absolutePath)))
    }

    @Test
    fun aDirectoryNamedServerIsNotEnoughToTrustItsParentRuntime() {
        val dist = dist()
        File(dist, "TaskBridge.exe").delete()
        val unrelated = File(dist, "runtime/node/node.exe")
        assertEquals("node", resolve(File(dist, "server"), present = setOf(unrelated.absolutePath)))
    }

    @Test
    fun aRuntimeInsideTheServerRootIsHonoured() {
        val root = File(sandbox(), "repository").apply { mkdirs() }
        val node = File(root, "runtime/node/node.exe")
        assertEquals("node", resolve(root))
        assertEquals(node.absolutePath, resolve(root, present = setOf(node.absolutePath)))
    }

    @Test
    fun theBinaryNameFollowsThePlatform() {
        val dist = dist()
        val unix = File(dist, "runtime/node/node")
        val windows = File(dist, "runtime/node/node.exe")
        assertEquals(unix.absolutePath, resolve(File(dist, "server"), windows = false, present = setOf(unix.absolutePath)))
        assertEquals(windows.absolutePath, resolve(File(dist, "server"), windows = true, present = setOf(windows.absolutePath)))
    }
}
