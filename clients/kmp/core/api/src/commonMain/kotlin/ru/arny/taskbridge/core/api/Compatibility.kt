package ru.arny.taskbridge.core.api

/** API versions this client understands (docs/api-contract.md, «Правило версий»). */
val SUPPORTED_API_VERSIONS: Set<Int> = setOf(1)

sealed interface Compatibility {
    data object Ok : Compatibility
    data class UnsupportedApi(val serverVersion: Int) : Compatibility
}

/** A client must refuse a server whose apiVersion it does not know, not guess. */
fun compatibilityOf(info: ApiInfo): Compatibility =
    if (info.apiVersion in SUPPORTED_API_VERSIONS) Compatibility.Ok else Compatibility.UnsupportedApi(info.apiVersion)
