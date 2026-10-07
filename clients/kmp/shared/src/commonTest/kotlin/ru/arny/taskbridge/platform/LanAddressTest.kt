package ru.arny.taskbridge.platform

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class LanAddressTest {
    @Test
    fun localNetworkRangesAreRecognized() {
        assertTrue(isLocalNetworkIpv4("10.0.0.1"))
        assertTrue(isLocalNetworkIpv4("10.255.255.255"))
        assertTrue(isLocalNetworkIpv4("172.16.0.1"))
        assertTrue(isLocalNetworkIpv4("172.31.255.255"))
        assertTrue(isLocalNetworkIpv4("192.168.0.1"))
        assertTrue(isLocalNetworkIpv4("192.168.255.255"))
        assertTrue(isLocalNetworkIpv4("169.254.1.2"))
    }

    @Test
    fun publicAndMalformedAddressesAreNotLocalNetwork() {
        assertFalse(isLocalNetworkIpv4("172.15.255.255"))
        assertFalse(isLocalNetworkIpv4("172.32.0.1"))
        assertFalse(isLocalNetworkIpv4("192.169.0.1"))
        assertFalse(isLocalNetworkIpv4("8.8.8.8"))
        assertFalse(isLocalNetworkIpv4("localhost"))
        assertFalse(isLocalNetworkIpv4("taskbridge.local"))
        assertFalse(isLocalNetworkIpv4("192.168.0.999"))
        assertFalse(isLocalNetworkIpv4("192.168.0"))
    }
}
