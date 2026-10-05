import org.jetbrains.compose.desktop.application.dsl.TargetFormat

plugins {
    alias(libs.plugins.kotlinJvm)
    alias(libs.plugins.composeMultiplatform)
    alias(libs.plugins.composeCompiler)
}

val taskbridgeVersion = providers.gradleProperty("taskbridgeVersion").get()
require(file("src/main/resources/taskbridge-version.txt").readText().trim() == taskbridgeVersion) {
    "Desktop version resource must match taskbridgeVersion"
}

dependencies {
    implementation(project(":shared"))

    implementation(compose.desktop.currentOs)
    implementation(libs.kotlinx.coroutinesSwing)

    implementation(libs.compose.uiToolingPreview)
}

compose.desktop {
    application {
        mainClass = "ru.arny.taskbridge.MainKt"

        nativeDistributions {
            targetFormats(TargetFormat.Dmg, TargetFormat.Msi, TargetFormat.Deb)
            packageName = "TaskBridge"
            packageVersion = taskbridgeVersion
            // A trimmed runtime: what suggestRuntimeModules found, plus TLS (the proxy's https port) and logging for OkHttp.
            modules("java.instrument", "java.management", "java.prefs", "jdk.unsupported", "jdk.crypto.ec", "java.logging")
            windows {
                iconFile.set(project.file("icons/TaskBridge.ico"))
                // The installer: a desktop shortcut and a Start menu entry; a fixed id so a new MSI upgrades the old one.
                shortcut = true
                menuGroup = "TaskBridge"
                upgradeUuid = "fa47f121-182a-4fa8-a174-3c45df881f52"
            }
        }
    }
}
// Portable build: TaskBridge.exe with app/ and runtime/ beside it.
// Written into a staging directory so the build never touches the running
// install — Windows locks TaskBridge.exe, icudtl.dat and the bundled runtime
// while the app is open, which used to fail this task.
// ./gradlew :desktopApp:portable
tasks.register<Sync>("portable") {
    dependsOn("createDistributable")
    from(layout.buildDirectory.dir("compose/binaries/main/app/TaskBridge"))
    into(rootProject.layout.projectDirectory.dir("dist/.staging/TaskBridge"))
}

// Moves the staged build over dist/TaskBridge. Run with TaskBridge closed, or
// let the app apply it and restart itself (tray → «Установить обновление»).
tasks.register<Sync>("installPortable") {
    dependsOn("portable")
    from(rootProject.layout.projectDirectory.dir("dist/.staging/TaskBridge"))
    into(rootProject.layout.projectDirectory.dir("dist/TaskBridge"))
}

// Standalone distribution: the same app image plus a copy of the Node server inside it
// (`<dist>/server`), so a ZIP unpacked on a machine without this repository still can
// start the local server. The copy is deliberately NOT taken by the development build:
// the app prefers the live repository and only falls back to `<dist>/server`
// (DesktopServerLauncher.bundledServer), otherwise edits to src/*.mjs would stop
// affecting the running app.
// `node` itself is still required in PATH — bundling a runtime is a separate decision.
// ./gradlew :desktopApp:standalonePortable
val repositoryRoot: File = generateSequence(rootProject.projectDir) { it.parentFile }
    .firstOrNull { File(it, "scripts/start-lan.mjs").isFile }
    ?: error("рядом с clients/kmp нет корня TaskBridge (scripts/start-lan.mjs)")

tasks.register<Sync>("standalonePortable") {
    dependsOn("portable")
    into(rootProject.layout.projectDirectory.dir("dist/.staging/TaskBridge/server"))
    from(repositoryRoot) {
        include("scripts/**", "src/**", "web/**", "pi-extension/**", "package.json", "config.example.json")
        exclude("**/node_modules/**", "**/*.log")
    }
    // Verify after the copy: the gate looks for the repository above `app/`, so the
    // standalone layout has to be checked with the bundled server in place.
    finalizedBy("verifyPortableRoot")
}

// The app starts the local server by running scripts/start-lan.mjs from the TaskBridge
// repository root; it finds that root by walking up from its own code location (the
// `app/` directory of the distribution). Two checks together, because the 2026-10-05
// bug slipped through both kinds of blindness:
//   * :shared:jvmTest — the shipped algorithm on synthetic layouts and on its own code
//     anchor (a depth bound fails there);
//   * this task — the PACKAGED tree: either scripts/start-lan.mjs is above `app/`
//     (development layout) or the standalone copy sits in `server/` beside it.
// Override for a different distribution root: -PtaskbridgeStagingDir=<path>
tasks.register("verifyPortableRoot") {
    dependsOn(":shared:jvmTest")
    val staging = providers.gradleProperty("taskbridgeStagingDir")
        .map { File(it) }
        .orElse(rootProject.layout.projectDirectory.dir("dist/.staging/TaskBridge").asFile)
    doLast {
        val dist = staging.get()
        val app = File(dist, "app")
        check(app.isDirectory) { "verifyPortableRoot: нет каталога $app — сначала соберите :desktopApp:portable" }
        val bundled = File(dist, "server/scripts/start-lan.mjs")
        val root = generateSequence(app) { it.parentFile }.firstOrNull { File(it, "scripts/start-lan.mjs").isFile }
        check(root != null || bundled.isFile) {
            "verifyPortableRoot: вверх от $app нет scripts/start-lan.mjs и нет встроенной копии ($bundled) — " +
                "собранное приложение не сможет запустить локальный сервер"
        }
        logger.lifecycle(
            "verifyPortableRoot: корень TaskBridge — " +
                (root?.toString() ?: "встроенная копия ${bundled.parentFile.parentFile}"),
        )
    }
}

tasks.named("portable") { finalizedBy("verifyPortableRoot") }
