package ru.arny.taskbridge

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

class MainActivity : ComponentActivity() {
    private var openTaskId by mutableStateOf<String?>(null)

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val app = application as TaskBridgeApplication
        openTaskId = intent?.getStringExtra(EXTRA_TASK_ID)
        askForNotifications()
        setContent {
            App(app.graph, openTaskId = openTaskId)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // A tapped notification while the app is open: go to that session.
        intent.getStringExtra(EXTRA_TASK_ID)?.let { openTaskId = it }
    }

    override fun onStart() {
        super.onStart()
        val app = application as TaskBridgeApplication
        app.platform.foreground = true
        app.graph.connection?.wakeUp()
    }

    override fun onStop() {
        (application as TaskBridgeApplication).platform.foreground = false
        super.onStop()
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
