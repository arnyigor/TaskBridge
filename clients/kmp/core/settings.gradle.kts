// Client logic of TaskBridge (API, sync, state) as its own Gradle build.
//
// It has no Android plugin on purpose: it builds and tests on any JDK with
// Maven Central only, and the apps consume it through includeBuild("core").
// The code lives in commonMain on multiplatform libraries, so the shared UI
// module can use it from commonMain; Android gets the JVM variant.
rootProject.name = "taskbridge-core"

pluginManagement {
    repositories {
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
    versionCatalogs {
        create("libs") {
            from(files("../gradle/libs.versions.toml"))
        }
    }
}

include(":api")
include(":client")
