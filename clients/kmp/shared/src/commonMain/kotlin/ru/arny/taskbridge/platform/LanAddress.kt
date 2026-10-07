package ru.arny.taskbridge.platform

/**
 * True for IPv4 literals that should use the local Wi-Fi route to TaskBridge.
 * This is a routing hint for the TaskBridge host, not an Internet-availability check.
 */
fun isLocalNetworkIpv4(host: String): Boolean {
    val parts = host.split('.')
    if (parts.size != 4) return false
    val octets = parts.map { it.toIntOrNull() ?: return false }
    if (octets.any { it !in 0..255 }) return false
    val a = octets[0]
    val b = octets[1]
    return a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 169 && b == 254)
}
