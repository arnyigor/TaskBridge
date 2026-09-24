package ru.arny.taskbridge

interface Platform {
    val name: String
}

expect fun getPlatform(): Platform