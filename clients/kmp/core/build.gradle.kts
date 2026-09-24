plugins {
    alias(libs.plugins.kotlinMultiplatform) apply false
    alias(libs.plugins.kotlinSerialization) apply false
}

allprojects {
    group = "ru.arny.taskbridge.core"
}
