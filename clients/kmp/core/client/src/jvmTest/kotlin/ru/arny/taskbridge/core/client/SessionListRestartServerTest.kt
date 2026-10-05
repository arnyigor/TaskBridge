package ru.arny.taskbridge.core.client

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import ru.arny.taskbridge.core.api.SimpleConnection
import ru.arny.taskbridge.core.api.TaskBridgeApi
import ru.arny.taskbridge.core.client.sessions.SessionList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * «Перезапустить сервер» когда он недоступен: desktop-клиент запускает сервер
 * сам (startLocalServer), Android честно отказывается. Живой сервер идёт по
 * старому пути POST /api/server/restart.
 */
class SessionListRestartServerTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private var boot = "boot-1"
    private var restartCalled = 0
    private var launched = 0

    /** /api/info отвечает bootId только после launch() — до этого сервер «потушен». */
    private fun api() = TaskBridgeApi(
        HttpClient(MockEngine { request ->
            val json = headersOf(HttpHeaders.ContentType, "application/json")
            when {
                request.url.encodedPath == "/api/info" && boot.isNotEmpty() ->
                    respond("""{"bootId":"$boot"}""", HttpStatusCode.OK, json)
                request.method == HttpMethod.Post && request.url.encodedPath == "/api/server/restart" -> {
                    restartCalled += 1
                    boot = "boot-2"
                    respond("""{"restarting":true}""", HttpStatusCode.Accepted, json)
                }
                request.url.encodedPath == "/api/tasks" -> respond("[]", HttpStatusCode.OK, json)
                request.url.encodedPath == "/api/projects" -> respond("[]", HttpStatusCode.OK, json)
                else -> respond("""{"version":1}""", HttpStatusCode.OK, json)
            }
        }),
        SimpleConnection("http://pc:8787"),
    )

    private fun sessions(launcher: (suspend () -> Unit)?, available: Boolean = launcher != null) = SessionList(
        api(), scope, clockMillis = { 0 },
        startLocalServer = launcher,
        localServerAvailable = { available },
    )


    @Test
    fun aStoppedServerIsStartedLocallyWithoutConsole() = runBlocking {
        val sessionList = sessions({ launched += 1; boot = "boot-2" })
        boot = "" // сервер потушен: /api/info не отвечает
        val result = sessionList.restartServer(timeoutMillis = 5_000, stepMillis = 10)
        assertTrue(result.isSuccess, "${result.exceptionOrNull()}")
        assertEquals(1, launched, "потушенный сервер поднимается лаунчером")
        assertEquals(0, restartCalled, "POST /api/server/restart по мёртвому серверу не нужен")
        scope.cancel()
    }

    @Test
    fun withoutALauncherTheFailureSaysHowToStartTheServer() = runBlocking {
        val sessionList = sessions(null)
        boot = "" // сервер недоступен
        val result = sessionList.restartServer(timeoutMillis = 5_000, stepMillis = 10)
        assertTrue(result.isFailure)
        assertTrue(
            result.exceptionOrNull()?.message?.contains("запустите TaskBridge") == true,
            "сообщение должно объяснять, что сервер запускают на компьютере",
        )
        scope.cancel()
    }

    @Test
    fun aLivingServerStillRestartsOverHttp() = runBlocking {
        val sessionList = sessions({ launched += 1 })
        val result = sessionList.restartServer(timeoutMillis = 5_000, stepMillis = 10)
        assertTrue(result.isSuccess, "${result.exceptionOrNull()}")
        assertEquals(1, restartCalled, "живой сервер перезапускается по HTTP, как раньше")
        assertEquals(0, launched, "лаунчер не нужен, пока сервер отвечает")
        scope.cancel()
    }

    /**
     * Каталог TaskBridge не найден (нет `scripts/start-lan.mjs`): лаунчер есть, но
     * поднять сервер им нечем. Вместо исключения из лаунчера — понятное сообщение,
     * что делать, и никакой попытки запуска.
     */
    @Test
    fun aLauncherWithoutARootSaysWhereToSetTheFolder() = runBlocking {
        val sessionList = sessions({ launched += 1 }, available = false)
        boot = "" // сервер потушен
        val result = sessionList.restartServer(timeoutMillis = 5_000, stepMillis = 10)
        assertTrue(result.isFailure)
        assertEquals(0, launched, "без найденного каталога сервер не поднимаем")
        assertTrue(
            result.exceptionOrNull()?.message?.contains("укажите его в настройках") == true,
            "сообщение должно отправлять в настройки: ${result.exceptionOrNull()?.message}",
        )
        scope.cancel()
    }

    @Test
    fun theDialogIsOnlyPromisedAHiddenStartWhenItCanWork() {
        assertTrue(sessions({ }).canStartLocalServer(), "лаунчер с найденным каталогом — обещаем запуск")
        assertTrue(!sessions(null).canStartLocalServer(), "на Android лаунчера нет — не обещаем")
        assertTrue(!sessions({ }, available = false).canStartLocalServer(), "каталог не найден — не обещаем")
        scope.cancel()
    }
}
