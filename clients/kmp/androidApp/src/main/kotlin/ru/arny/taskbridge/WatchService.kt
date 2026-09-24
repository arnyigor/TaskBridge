package ru.arny.taskbridge

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import ru.arny.taskbridge.platform.AndroidPlatformServices

/**
 * Keeps the process alive while the agent works and the app is not on screen
 * (KMP plan K7: LAN only, no push service). The service itself does nothing
 * but hold a foreground notification: the AppGraph's session list keeps
 * polling in the process, and its alerts become system notifications.
 *
 * Type dataSync. Android 15 limits it to 6 hours a day; after that the system
 * stops the service and notifications arrive only while the app is open.
 */
class WatchService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val active = intent?.getIntExtra(EXTRA_ACTIVE, 1) ?: 1
        val notification = buildNotification(active)
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        return START_NOT_STICKY
    }

    override fun onTimeout(startId: Int) {
        // Android 15: the dataSync budget is spent. Stop cleanly.
        stopSelf()
    }

    private fun buildNotification(active: Int): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        AndroidPlatformServices.ensureChannels(manager)
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        @Suppress("DEPRECATION")
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, AndroidPlatformServices.CHANNEL_WATCH) else Notification.Builder(this)
        return builder
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Агент работает")
            .setContentText(if (active == 1) "1 сессия — сообщу, когда понадобится ответ" else "Сессий: $active — сообщу, когда понадобится ответ")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val NOTIFICATION_ID = 42
        private const val EXTRA_ACTIVE = "active"
        @Volatile private var running = false

        /** Called on every list update: runs while something is active, stops otherwise. */
        fun update(context: Context, activeSessions: Int) {
            val intent = Intent(context, WatchService::class.java).putExtra(EXTRA_ACTIVE, activeSessions)
            if (activeSessions > 0) {
                // Android 12+ refuses to start a foreground service from the
                // background; it is started while the app is open and simply
                // keeps running after it is hidden.
                runCatching {
                    if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
                    running = true
                }
            } else if (running) {
                context.stopService(intent)
                running = false
            }
        }
    }
}
