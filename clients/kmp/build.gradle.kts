plugins {
    // this is necessary to avoid the plugins to be loaded multiple times
    // in each subproject's classloader
    alias(libs.plugins.androidApplication) apply false
    alias(libs.plugins.androidMultiplatformLibrary) apply false
    alias(libs.plugins.composeMultiplatform) apply false
    alias(libs.plugins.composeCompiler) apply false
    alias(libs.plugins.kotlinJvm) apply false
    alias(libs.plugins.kotlinMultiplatform) apply false
    alias(libs.plugins.kotlinSerialization) apply false
    alias(libs.plugins.ktlint) apply false
    alias(libs.plugins.detekt) apply false
}

// Static analysis for every Kotlin module of this build.
// `./gradlew ktlintCheck` / `./gradlew detekt` — style and defect checks that the
// tests do not see. Formatting is applied deliberately (`ktlintFormat`), never
// as part of a normal build.
subprojects {
    apply(plugin = "org.jlleitschuh.gradle.ktlint")
    apply(plugin = "io.gitlab.arturbosch.detekt")
}

// detekt keeps the Phase A audit's config and baseline (docs/STATIC_ANALYSIS_AUDIT.md):
// 2269 existing findings are recorded, `maxIssues: 0` fails the build on a NEW one.
subprojects {
    plugins.withId("io.gitlab.arturbosch.detekt") {
        extensions.configure<io.gitlab.arturbosch.detekt.extensions.DetektExtension>("detekt") {
            config.setFrom(rootProject.files("config/analysis/detekt-config.yml"))
            baseline = rootProject.file("config/analysis/detekt-baseline.xml")
            buildUponDefaultConfig = true
            parallel = true
            // KMP modules keep their sources under src/<target>/kotlin, not src/main.
            source.setFrom(
                rootProject.fileTree(projectDir) {
                    include("src/**/kotlin/**/*.kt")
                    exclude("**/build/**")
                }
            )
        }
    }
}

// Lint sources only: generator output under build/ is not ours to restyle.
subprojects {
    plugins.withId("org.jlleitschuh.gradle.ktlint") {
        extensions.configure<org.jlleitschuh.gradle.ktlint.KtlintExtension>("ktlint") {
            filter { exclude { it.file.path.contains("${File.separator}build${File.separator}") } }
        }
    }
}


// Long lines that predate the checks are frozen in a baseline: the build fails on
// a *new* over-long line, while the existing ones are wrapped when touched.
subprojects {
    plugins.withId("org.jlleitschuh.gradle.ktlint") {
        extensions.configure<org.jlleitschuh.gradle.ktlint.KtlintExtension>("ktlint") {
            baseline = rootProject.file("config/ktlint-baseline.xml")
        }
    }
}
