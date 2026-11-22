plugins {
    alias(libs.plugins.kotlinMultiplatform) apply false
    alias(libs.plugins.kotlinSerialization) apply false
    alias(libs.plugins.ktlint) apply false
    alias(libs.plugins.detekt) apply false
}

allprojects {
    group = "ru.arny.taskbridge.core"
}

// Static analysis for the client logic build (`./gradlew -p core ktlintCheck`,
// `-p core detekt`). Settings live in the shared .editorconfig of clients/kmp.
subprojects {
    apply(plugin = "org.jlleitschuh.gradle.ktlint")
    apply(plugin = "io.gitlab.arturbosch.detekt")
}

// Same detekt config and baseline as the app build (kept in clients/kmp/config).
subprojects {
    plugins.withId("io.gitlab.arturbosch.detekt") {
        extensions.configure<io.gitlab.arturbosch.detekt.extensions.DetektExtension>("detekt") {
            config.setFrom(rootProject.files("../config/analysis/detekt-config.yml"))
            baseline = rootProject.file("../config/analysis/detekt-baseline.xml")
            buildUponDefaultConfig = true
            parallel = true
            source.setFrom(
                rootProject.fileTree(projectDir) {
                    include("src/**/kotlin/**/*.kt")
                    exclude("**/build/**")
                }
            )
        }
    }
}

subprojects {
    plugins.withId("org.jlleitschuh.gradle.ktlint") {
        extensions.configure<org.jlleitschuh.gradle.ktlint.KtlintExtension>("ktlint") {
            // Generator output under build/ is not ours to restyle.
            filter { exclude { it.file.path.contains("${File.separator}build${File.separator}") } }
            // Pre-existing over-long lines are frozen; a new one fails the build.
            // One file per module: ktlint resolves the entries relative to the
            // project the baseline belongs to.
            baseline = project.file("ktlint-baseline.xml")
        }
    }
}
