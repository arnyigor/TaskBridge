package ru.arny.taskbridge.core.client

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import ru.arny.taskbridge.core.api.SimpleConnection
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.client.settings.ConnectResult
import ru.arny.taskbridge.core.client.settings.checkConnection
import ru.arny.taskbridge.core.client.settings.savedAddressNeedsPairing
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

class ConnectionCheckTest {

    private fun api(auth: String, connection: SimpleConnection) = TaskBridgeApi(
        HttpClient(MockEngine { request ->
            val json = headersOf(HttpHeaders.ContentType, "application/json")
            when (request.url.encodedPath) {
                "/api/auth" -> respond(auth, HttpStatusCode.OK, json)
                else -> respond("""{"apiVersion":1}""", HttpStatusCode.OK, json)
            }
        }),
        connection,
    )

    private val tokensServer = """{"authenticated":true,"enabled":true,"local":false,"deviceTokens":true}"""

    @Test
    fun aCookieOnlyClientPairsAgainWithATokenServer() = runBlocking<Unit> {
        val result = checkConnection(api(tokensServer, SimpleConnection("http://pc:8787", sessionCookie = "1.2.3")))
        assertIs<ConnectResult.NeedsPairing>(result)
    }

    @Test
    fun aTokenClientIsReady() = runBlocking<Unit> {
        val result = checkConnection(api(tokensServer, SimpleConnection("http://pc:8787", authToken = "ab".repeat(32))))
        assertIs<ConnectResult.Ready>(result)
    }

    @Test
    fun anOldServerKeepsTheCookie() = runBlocking<Unit> {
        val old = """{"authenticated":true,"enabled":true,"local":false}"""
        assertIs<ConnectResult.Ready>(checkConnection(api(old, SimpleConnection("http://pc:8787", sessionCookie = "1.2.3"))))
    }

    // A phone that connected while the PC had pairing off keeps its address and no
    // token; once the PC turns pairing on, this is what sends it back to the code.
    private val unpaired = """{"authenticated":false,"enabled":true,"local":false,"deviceTokens":true}"""

    @Test
    fun aDeviceThatNeverPairedGoesBackToTheCode() = runBlocking<Unit> {
        assertTrue(savedAddressNeedsPairing(api(unpaired, SimpleConnection("http://pc:8787"))))
    }

    @Test
    fun aPairedDeviceKeepsItsAddress() = runBlocking<Unit> {
        assertFalse(savedAddressNeedsPairing(api(tokensServer, SimpleConnection("http://pc:8787", authToken = "ab".repeat(32)))))
    }

    @Test
    fun anUnreachableDaemonStaysOnTheOfflineList() = runBlocking<Unit> {
        val offline = TaskBridgeApi(
            HttpClient(MockEngine { throw IOException("Connection refused") }),
            SimpleConnection("http://pc:8787"),
        )
        assertFalse(savedAddressNeedsPairing(offline))
    }
}
