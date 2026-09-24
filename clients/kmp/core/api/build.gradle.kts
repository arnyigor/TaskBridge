import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.kotlinSerialization)
}

kotlin {
    jvm {
        compilerOptions {
            // The same bytecode level as the Android and desktop modules.
            jvmTarget = JvmTarget.JVM_11
        }
    }

    sourceSets {
        commonMain.dependencies {
            api(libs.ktor.client.core)
            api(libs.kotlinx.serialization.json)
            api(libs.kotlinx.coroutines.core)
        }
        commonTest.dependencies {
            implementation(libs.kotlin.test)
            implementation(libs.kotlinx.coroutines.test)
            implementation(libs.ktor.client.mock)
            implementation(libs.turbine)
        }
    }
}

tasks.withType<Test>().configureEach {
    // Recorded server responses: tests/fixtures/api at the repository root,
    // written by scripts/export-api-fixtures.mjs.
    systemProperty("taskbridge.fixtures", rootProject.projectDir.resolve("../../../tests/fixtures/api").canonicalPath)
}
