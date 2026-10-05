package ru.arny.taskbridge.platform

import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Поиск корня TaskBridge для запуска локального сервера. Регрессия 2026-10-05:
 * поиск ограничивался четырьмя кандидатами от рабочего каталога процесса, а
 * портативная сборка лежит на четыре уровня ниже корня ([portableDistLayout]),
 * поэтому корень не находился вообще и кнопка «Запустить сервер» падала с
 * «Каталог TaskBridge (scripts/start-lan.mjs) не найден».
 */
class TaskBridgeRootFinderTest {

    private fun repo(): File = Files.createTempDirectory("taskbridge-root").toFile().apply {
        File(this, "scripts").mkdirs()
        File(this, "scripts/start-lan.mjs").writeText("// marker")
    }

    /** `clients/kmp/dist/TaskBridge` — каталог, из которого запускается portable-сборка. */
    private fun portableDistLayout(repo: File): File =
        File(repo, "clients/kmp/dist/TaskBridge").apply { mkdirs() }

    /** `clients/kmp/desktopApp` — рабочий каталог `gradle run`. */
    private fun gradleRunLayout(repo: File): File =
        File(repo, "clients/kmp/desktopApp").apply { mkdirs() }

    /** Каталог с кодом приложения внутри дистрибутива (`<dist>/app`). */
    private fun appDir(dist: File): File = File(dist, "app").apply { mkdirs() }

    /**
     * Копия сервера внутри дистрибутива (`:desktopApp:standalonePortable`): в распакованном
     * ZIP репозитория рядом нет, и корнем становится она. Идёт последним якорем — рядом с
     * репозиторием всегда побеждает живой код.
     */
    private fun bundledServer(dist: File): File = File(dist, "server").apply {
        File(this, "scripts").mkdirs()
        File(this, "scripts/start-lan.mjs").writeText("// bundled marker")
    }

    @Test
    fun portableDistFindsTheRepoRootAboveIt() {
        val repo = repo()
        val found = findTaskBridgeRoot(null, listOf(portableDistLayout(repo)))
        assertEquals(repo.canonicalFile, found?.canonicalFile)
    }

    @Test
    fun gradleRunWorkingDirectoryFindsTheRepoRoot() {
        val repo = repo()
        val found = findTaskBridgeRoot(null, listOf(gradleRunLayout(repo)))
        assertEquals(repo.canonicalFile, found?.canonicalFile)
    }

    /** Якорь в списке позже, чем рабочий каталог: последний побеждает только если ничего не нашлось раньше. */
    @Test
    fun firstAnchorWithARootWins() {
        val repo = repo()
        val other = repo()
        val found = findTaskBridgeRoot(null, listOf(portableDistLayout(repo), portableDistLayout(other)))
        assertEquals(repo.canonicalFile, found?.canonicalFile)
    }

    @Test
    fun explicitSettingWinsOverTheWorkingDirectory() {
        val repo = repo()
        val found = findTaskBridgeRoot(repo.absolutePath, listOf(portableDistLayout(repo())))
        assertEquals(repo.canonicalFile, found?.canonicalFile)
    }

    /** Настройка без `scripts/start-lan.mjs` не ломает поиск: дальше проверяются якоря. */
    @Test
    fun staleSettingFallsThroughToTheAnchors() {
        val repo = repo()
        val empty = Files.createTempDirectory("taskbridge-empty").toFile()
        val found = findTaskBridgeRoot(empty.absolutePath, listOf(portableDistLayout(repo)))
        assertEquals(repo.canonicalFile, found?.canonicalFile)
    }

    @Test
    fun noRepoAnywhereMeansNoRoot() {
        val isolated = Files.createTempDirectory("taskbridge-no-repo").toFile()
        assertNull(findTaskBridgeRoot(null, listOf(isolated)))
    }

    /** ZIP, распакованный без репозитория: корнем становится встроенная копия сервера. */
    @Test
    fun bundledServerIsTheLastResort() {
        val dist = Files.createTempDirectory("taskbridge-zip-").toFile()
        val bundled = bundledServer(dist)
        val found = findTaskBridgeRoot(null, listOf(appDir(dist), bundled))
        assertEquals(bundled.canonicalFile, found?.canonicalFile)
    }

    /** В разработке рядом лежит репозиторий — он и должен побеждать, иначе правки сервера не действуют. */
    @Test
    fun theRepositoryWinsOverTheBundledCopy() {
        val repo = repo()
        val dist = portableDistLayout(repo)
        val bundled = bundledServer(dist)
        val found = findTaskBridgeRoot(null, listOf(appDir(dist), bundled))
        assertEquals(repo.canonicalFile, found?.canonicalFile, "при живом репозитории берём его, а не копию")
    }

    /**
     * Тост при неудачном запуске сервера показывал хвост вывода, забитый предупреждениями Node,
     * и причины в нём не было видно (2026-10-05: «TaskBridge уже запущен (PID 13220)» терялось
     * среди `(node:NNN) DeprecationWarning`).
     */
    @Test
    fun readableOutputDropsNodeNoiseAndKeepsTheReason() {
        val raw = listOf(
            "(node:17748) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to",
            "(Use `node --trace-deprecation ...` to show where the warning was created)",
            "(node:26216) [DEP0190] DeprecationWarning: Passing args to a child process",
            "TaskBridge уже запущен (PID 13220). Остановите его и повторите.",
            "(node:23480) [DEP0190] DeprecationWarning: Passing args to a child process",
            "[lan] the app did not come up. Its log says:",
        ).joinToString("\n")
        val shown = readableOutput(raw)
        assertTrue(shown.contains("уже запущен (PID 13220)"), shown)
        assertTrue(shown.contains("did not come up"), shown)
        assertTrue(shown.lines().none { it.contains("DeprecationWarning") }, shown)
        assertTrue(shown.lines().none { it.contains("trace-deprecation") }, shown)
    }

    @Test
    fun readableOutputKeepsTheTailAndSurvivesEmptyText() {
        val long = (1..40).joinToString("\n") { "[lan] line $it" }
        assertEquals(3, readableOutput(long, tail = 3).lines().size)
        assertTrue(readableOutput(long, tail = 3).endsWith("[lan] line 40"))
        assertTrue(readableOutput("\n\n").isNotBlank()) // пустой вывод → подсказка, а не пустой тост
    }

    /**
     * Якорь «местоположение своего кода» — тот, которым пользуется ланчер в сборке
     * (`codeLocation`), — обязан доводить до корня репозитория независимо от того, какой
     * рабочий каталог у процесса. Раньше от него не считали вообще, а от рабочего каталога
     * ходили всего на четыре кандидата: эта проверка ловит и первое, и второе.
     */
    @Test
    fun codeAnchorReachesTheRepoRoot() {        val anchor = codeLocation(TaskBridgeRootFinderTest::class.java)
        assertNotNull(anchor, "у класса нет каталога с кодом")
        val found = findTaskBridgeRoot(null, listOf(anchor))
        assertNotNull(found, "вверх от $anchor не найден корень TaskBridge")
        assertTrue(File(found, "scripts/start-lan.mjs").isFile, "в $found нет scripts/start-lan.mjs")
        assertTrue(
            anchor.canonicalPath.startsWith(found.canonicalPath),
            "найденный корень $found не содержит якорь $anchor",
        )
    }

    @Test
    fun candidatesCoverEveryAnchorAndItsParents() {
        val repo = repo()
        val dist = portableDistLayout(repo)
        val candidates = taskBridgeRootCandidates(repo.absolutePath, listOf(dist))
        assertEquals(File(repo.absolutePath).canonicalFile, candidates.first().canonicalFile)
        // Все уровни вложенности между сборкой и корнем, включая сам корень репозитория.
        listOf(dist, dist.parentFile, File(repo, "clients/kmp"), File(repo, "clients"), repo)
            .forEach { expected ->
                assertEquals(
                    true,
                    candidates.any { candidate -> candidate.canonicalFile == expected.canonicalFile },
                    "нет кандидата $expected",
                )
            }
    }
}
