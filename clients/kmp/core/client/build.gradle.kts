import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.kotlinSerialization)
}

kotlin {
    jvm {
        compilerOptions {
            jvmTarget = JvmTarget.JVM_11
        }
    }

    sourceSets {
        commonMain.dependencies {
            api(project(":api"))
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
    systemProperty("taskbridge.fixtures", rootProject.projectDir.resolve("../../../tests/fixtures/api").canonicalPath)
    // Golden files: events + what web/chat-state.mjs builds from them (scripts/export-chat-fixtures.mjs).
    systemProperty("taskbridge.chatFixtures", rootProject.projectDir.resolve("../../../tests/fixtures/chat").canonicalPath)
}
