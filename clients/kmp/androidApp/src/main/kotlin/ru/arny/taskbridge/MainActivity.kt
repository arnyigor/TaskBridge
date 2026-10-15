package ru.arny.taskbridge

import android.Manifest
import android.content.Intent
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
        // Saved navigation already includes any notification that was handled.
        // Replaying the launch intent on rotation would reopen an older chat.
        openTaskId = if (savedInstanceState == null) intent?.getStringExtra(EXTRA_TASK_ID) else null
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
        app.graph.connection?.wakeUp()
    }

    override fun onStop() {
        val app = application as TaskBridgeApplication
        app.platform.foreground = false
        // The process may stay alive for notifications, but no hidden chat keeps
        // an SSE socket or decodes heartbeat-triggered snapshots in the background.
        app.graph.connection?.appVisibilityChanged()
        super.onStop()
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
