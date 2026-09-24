package ru.arny.taskbridge.platform

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import ru.arny.taskbridge.core.api.UploadFile
import ru.arny.taskbridge.core.client.sessions.SessionAlert
import ru.arny.taskbridge.core.client.settings.KeyValueStore
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

class SharedPreferencesStore(context: Context) : KeyValueStore {
    private val prefs = context.getSharedPreferences("taskbridge", Context.MODE_PRIVATE)
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun put(key: String, value: String?) {
        prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
    }
}

/**
 * Android services. [launchIntent] opens the app on a session (the extra
 * `taskId`); [watcher] starts/stops the background watch service.
 */
class AndroidPlatformServices(
    private val context: Context,
    private val launchIntent: (taskId: String?) -> Intent,
    private val watcher: (activeSessions: Int) -> Unit,
) : PlatformServices {
    override val kind: String = "android"
    override val store: KeyValueStore = SharedPreferencesStore(context)

    @Volatile
    var foreground: Boolean = false
    override val inForeground: Boolean get() = foreground

    private val notifications = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    override fun httpClient(): HttpClient = HttpClient(OkHttp) {
        engine {
            config {
                connectTimeout(10, TimeUnit.SECONDS)
                readTimeout(0, TimeUnit.MILLISECONDS)
                retryOnConnectionFailure(true)
            }
        }
    }

    override fun copyText(text: String) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("TaskBridge", text))
    }

    override fun formatClock(epochMillis: Long): String = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(epochMillis))

    override fun formatDate(epochMillis: Long): String = SimpleDateFormat("d MMM", Locale.forLanguageTag("ru")).format(Date(epochMillis))

    override fun notify(alert: SessionAlert) {
        ensureChannels(notifications)
        val channel = if (alert.kind == SessionAlert.Kind.WAITING_USER) CHANNEL_URGENT else CHANNEL_UPDATES
        val intent = PendingIntent.getActivity(
            context, alert.taskId.hashCode(), launchIntent(alert.taskId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        @Suppress("DEPRECATION")
        val builder = if (Build.VERSION.SDK_INT >= 26) android.app.Notification.Builder(context, channel) else android.app.Notification.Builder(context)
        val notification = builder
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(
                when (alert.kind) {
                    SessionAlert.Kind.WAITING_USER -> "Ждёт ответа · ${alert.title}"
                    SessionAlert.Kind.FINISHED -> "Готово · ${alert.title}"
                    SessionAlert.Kind.FAILED -> "Ошибка · ${alert.title}"
                },
            )
            .setContentText(alert.text)
            .setStyle(android.app.Notification.BigTextStyle().bigText(alert.text))
            .setContentIntent(intent)
            .setAutoCancel(true)
            .setGroup("sessions")
            .build()
        runCatching { notifications.notify(alert.key, NOTIFICATION_ID, notification) }
    }

    override fun clearNotification(taskId: String) {
        notifications.cancel("session:$taskId", NOTIFICATION_ID)
    }

    override fun setBackgroundWatch(activeSessions: Int) = watcher(activeSessions)

    override fun openUrl(url: String) {
        runCatching {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    companion object {
        const val CHANNEL_URGENT = "waiting_user"
        const val CHANNEL_UPDATES = "updates"
        const val CHANNEL_WATCH = "watch"
        const val NOTIFICATION_ID = 1

        fun ensureChannels(manager: NotificationManager) {
            if (Build.VERSION.SDK_INT < 26) return
            manager.createNotificationChannel(NotificationChannel(CHANNEL_URGENT, "Ждёт вашего ответа", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Агент остановился и ждёт решения"
            })
            manager.createNotificationChannel(NotificationChannel(CHANNEL_UPDATES, "Завершение задач", NotificationManager.IMPORTANCE_DEFAULT))
            manager.createNotificationChannel(NotificationChannel(CHANNEL_WATCH, "Наблюдение за сессиями", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Постоянное уведомление, пока агент работает, а приложение свёрнуто"
            })
        }
    }
}

@Composable
actual fun PlatformBackHandler(enabled: Boolean, onBack: () -> Unit) {
    BackHandler(enabled = enabled, onBack = onBack)
}

@Composable
actual fun rememberFilePicker(onPicked: (List<UploadFile>) -> Unit): () -> Unit {
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris: List<Uri> ->
        val files = uris.mapNotNull { uri -> readUri(context, uri) }
        if (files.isNotEmpty()) onPicked(files)
    }
    return { launcher.launch("*/*") }
}

private fun readUri(context: Context, uri: Uri): UploadFile? = runCatching {
    val resolver = context.contentResolver
    var name = "file"
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0)?.let { name = it }
    }
    val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
    UploadFile(name, resolver.getType(uri), bytes)
}.getOrNull()

@Composable
actual fun SystemBarsAppearance(dark: Boolean) {
    val view = LocalView.current
    SideEffect {
        val activity = generateSequence(view.context) { (it as? ContextWrapper)?.baseContext }.filterIsInstance<Activity>().firstOrNull() ?: return@SideEffect
        WindowCompat.getInsetsController(activity.window, view).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }
}
