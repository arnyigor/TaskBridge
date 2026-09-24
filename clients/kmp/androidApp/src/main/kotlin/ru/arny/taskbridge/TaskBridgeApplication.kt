package ru.arny.taskbridge

import android.app.Application
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import ru.arny.taskbridge.platform.AndroidPlatformServices

/**
 * Holds the one AppGraph of the process, so the activity (recreated on every
 * rotation) and the watch service share the same connection, list and chats.
 */
class TaskBridgeApplication : Application() {
    lateinit var platform: AndroidPlatformServices
        private set
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        platform = AndroidPlatformServices(
            context = this,
            launchIntent = { taskId ->
                Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    .apply { if (taskId != null) putExtra(MainActivity.EXTRA_TASK_ID, taskId) }
            },
            watcher = { active -> WatchService.update(this, active) },
        )
        graph = AppGraph(platform)
        // Wi-Fi back, or a switch between networks: reconnect now instead of
        // waiting out the backoff.
        val connectivity = getSystemService(ConnectivityManager::class.java)
        if (Build.VERSION.SDK_INT >= 24) {
            connectivity?.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    graph.connection?.wakeUp()
                }
            })
        }
    }
}
