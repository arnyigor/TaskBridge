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
