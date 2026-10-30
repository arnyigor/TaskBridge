package ru.arny.taskbridge

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

class MainActivity : ComponentActivity() {
    private var openTaskId by mutableStateOf<String?>(null)
    private var openRequestId by mutableStateOf(0L)

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Transparent navigation bar: the composer's own tint runs under it. The default
        // light scrim (and the system's contrast scrim) read as a blank white strip.
        enableEdgeToEdge(navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) window.isNavigationBarContrastEnforced = false
        super.onCreate(savedInstanceState)
        val app = application as TaskBridgeApplication
        // Kept for platform.exitApp(): the shared UI's «Выход» closes this activity.
        app.platform.activity = this
        // A notification tap is the only source of EXTRA_TASK_ID: the launcher intent never
        // carries it. The extra is consumed as soon as it is read, so a later recreation of
        // this Activity (rotation, or the system reclaiming the UI while the watch service
        // keeps the process alive) does not replay an older target. A real tap still arrives
        // with the extra even when the Activity had to restore its saved state first — that
        // was the tap that looked like nothing happened.
        intent?.getStringExtra(EXTRA_TASK_ID)?.let { tapped ->
            intent?.removeExtra(EXTRA_TASK_ID)
            openTaskId = tapped
        }
        askForNotifications()
        setContent {
            App(app.graph, openTaskId = openTaskId, openRequestId = openRequestId)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // A tapped notification while the app is open: go to that session.
        intent.getStringExtra(EXTRA_TASK_ID)?.let {
            // Consumed, so a later recreation of this Activity does not replay this tap.
            intent.removeExtra(EXTRA_TASK_ID)
            openTaskId = it
            // A second tap may name the same session after Back returned to the list.
            // Its delivery is new even though the target string has not changed.
            openRequestId++
        }
    }

    override fun onStart() {
        super.onStart()
        val app = application as TaskBridgeApplication
        app.platform.foreground = true
        // Экран, а не только жизненный цикл: активность может остаться Resumed при
        // погашенном экране, и тогда без этих событий ничто не пересчитает видимость.
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
        }
        runCatching { registerReceiver(screenReceiver, filter) }
        app.graph.connection?.wakeUp()
    }

    override fun onStop() {
        val app = application as TaskBridgeApplication
        runCatching { unregisterReceiver(screenReceiver) }
        app.platform.foreground = false
        // The process may stay alive for notifications, but no hidden chat keeps
        // an SSE socket or decodes heartbeat-triggered snapshots in the background.
        app.graph.connection?.appVisibilityChanged()
        super.onStop()
    }

    /**
     * Погас/зажёгся экран: сказать графу, что видимость изменилась.
     *
     * Сама видимость читается из `PowerManager.isInteractive` (см.
     * `AndroidPlatformServices.inForeground`), здесь нужен только повод пересчитать
     * её: закрыть SSE и тикающие счётчики при погасании и переподключиться при возврате.
     * Замер 2026-10-30: при позиции «экран погас, активность Resumed» телефон получал
     * 25% CPU в фоне за 5 минут — ровно поток живого чата, который никто не видел.
     */
    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val app = application as? TaskBridgeApplication ?: return
            app.graph.connection?.appVisibilityChanged()
            if (intent?.action == Intent.ACTION_SCREEN_ON) app.graph.connection?.wakeUp()
        }
    }

    override fun onDestroy() {
        val app = application as? TaskBridgeApplication
        if (app?.platform?.activity === this) app.platform.activity = null
        super.onDestroy()
    }

    /** Android 13+: without the permission the app still works, only silently. */
    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT < 33) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    companion object {
        const val EXTRA_TASK_ID = "taskId"
    }
}
