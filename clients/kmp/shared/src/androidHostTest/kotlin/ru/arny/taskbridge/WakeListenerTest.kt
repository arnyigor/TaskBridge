package ru.arny.taskbridge

import ru.arny.taskbridge.platform.WakeListener
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Свой push в локальной сети (4.3): сервер POST-ит `/wake` на приёмник телефона,
 * тот отвечает 204 и будит приложение. Промахи — штатны (запасной канал — опрос),
 * поэтому приёмник обязан отвечать быстро и не ронять поток.
 */
class WakeListenerTest {
    private var listener: WakeListener? = null

    @AfterTest
    fun stop() {
        listener?.close()
    }

    private fun post(port: Int, path: String): Int {
        val connection = URL("http://127.0.0.1:$port$path").openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.setRequestProperty("content-type", "application/json")
        connection.doOutput = true
        connection.outputStream.use { it.write("""{"taskId":"t1","type":"TASK_SUCCEEDED"}""".toByteArray()) }
        val status = connection.responseCode
        // 404 приходит как errorStream: HttpURLConnection бросает FileNotFoundException
        // на inputStream, поэтому тело читаем по статусу.
        if (status in 200..299) connection.inputStream.use { it.readBytes() }
        else connection.errorStream?.use { it.readBytes() }
        return status
    }

    @Test
    fun `a wake post answers 204 and wakes the app`() {
        val woken = CountDownLatch(1)
        listener = WakeListener(requestedPort = 0) { woken.countDown() }
        val port = listener!!.start()
        assertTrue(port > 0, "порт выдан системой")

        assertEquals(204, post(port, "/wake"))
        assertTrue(woken.await(2, TimeUnit.SECONDS), "приёмник должен разбудить приложение")
    }

    @Test
    fun `an unknown path is refused and does not wake the app`() {
        val woken = CountDownLatch(1)
        listener = WakeListener(requestedPort = 0) { woken.countDown() }
        val port = listener!!.start()

        assertEquals(404, post(port, "/other"))
        assertEquals(false, woken.await(300, TimeUnit.MILLISECONDS), "посторонний запрос не будит приложение")
    }

    @Test
    fun `close stops answering`() {
        listener = WakeListener(requestedPort = 0) { }
        val port = listener!!.start()
        listener!!.close()
        val refused = runCatching { post(port, "/wake") }.isFailure
        assertTrue(refused, "после close приёмник не принимает соединений")
    }
}
