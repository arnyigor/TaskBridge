package ru.arny.taskbridge.platform

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.net.Uri
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.ui.draganddrop.DragAndDropEvent
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import ru.arny.taskbridge.core.api.UploadFile
import ru.arny.taskbridge.core.client.sessions.SessionAlert
import ru.arny.taskbridge.core.client.session.CachedChat
import ru.arny.taskbridge.core.client.session.ChatPersistence
import ru.arny.taskbridge.core.client.session.PersistedOutgoing
import ru.arny.taskbridge.core.client.settings.KeyValueStore
import ru.arny.taskbridge.core.client.settings.SecretStore
import ru.arny.taskbridge.core.api.TaskBridgeJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.serialization.builtins.ListSerializer
import java.io.File
import java.net.URI
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.KeyStore
import javax.crypto.Cipher
import javax.net.SocketFactory
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.system.exitProcess

class SharedPreferencesStore(context: Context) : KeyValueStore {
    private val prefs = context.getSharedPreferences("taskbridge", Context.MODE_PRIVATE)
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun put(key: String, value: String?) {
        prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
    }
}

class AndroidKeystoreSecretStore(context: Context) : SecretStore {
    private val prefs = context.getSharedPreferences("taskbridge-secrets", Context.MODE_PRIVATE)
    private val cache = mutableMapOf<String, String?>()

    override fun get(key: String): String? {
        synchronized(cache) { if (cache.containsKey(key)) return cache[key] }
        val value = runCatching {
        val packed = Base64.decode(prefs.getString(key, null) ?: return null, Base64.NO_WRAP)
        require(packed.size > 12)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, packed, 0, 12))
        cipher.doFinal(packed.copyOfRange(12, packed.size)).decodeToString()
        }.getOrNull()
        synchronized(cache) { cache[key] = value }
        return value
    }

    override fun put(key: String, value: String?) {
        if (value == null) { prefs.edit().remove(key).apply(); synchronized(cache) { cache[key] = null }; return }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val packed = cipher.iv + cipher.doFinal(value.encodeToByteArray())
        prefs.edit().putString(key, Base64.encodeToString(packed, Base64.NO_WRAP)).commit()
        synchronized(cache) { cache[key] = value }
    }

    private fun secretKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build())
            generateKey()
        }
    }

    private companion object { const val KEY_ALIAS = "taskbridge-client-secrets-v1" }
}

private class AndroidChatPersistence(root: File, serverUrl: String) : ChatPersistence {
    private val dir = File(root, serverUrl.hashCode().toUInt().toString(16)).apply { mkdirs() }
    private fun file(taskId: String, suffix: String) = File(dir, taskId.replace(Regex("[^A-Za-z0-9._-]"), "_") + suffix)

    override suspend fun loadChat(taskId: String): CachedChat? = read(file(taskId, ".chat.json"), CachedChat.serializer())
    override suspend fun saveChat(taskId: String, value: CachedChat) = write(file(taskId, ".chat.json"), TaskBridgeJson.encodeToString(CachedChat.serializer(), value))
    override suspend fun loadOutbox(taskId: String): List<PersistedOutgoing> = read(file(taskId, ".outbox.json"), ListSerializer(PersistedOutgoing.serializer())).orEmpty()
    override suspend fun saveOutbox(taskId: String, values: List<PersistedOutgoing>) {
        val target = file(taskId, ".outbox.json")
        if (values.isEmpty()) withContext(Dispatchers.IO) { target.delete() }
        else write(target, TaskBridgeJson.encodeToString(ListSerializer(PersistedOutgoing.serializer()), values))
    }
    override suspend fun clear(taskId: String) = withContext(Dispatchers.IO) { file(taskId, ".chat.json").delete(); file(taskId, ".outbox.json").delete(); Unit }
    private suspend fun <T> read(file: File, serializer: kotlinx.serialization.KSerializer<T>): T? = withContext(Dispatchers.IO) {
        runCatching { TaskBridgeJson.decodeFromString(serializer, file.readText()) }.getOrNull()
    }
    private suspend fun write(file: File, text: String) = withContext(Dispatchers.IO) {
        file.parentFile?.mkdirs()
        // One temp name per write: a shared ".tmp" was moved away by the first of
        // two concurrent writers (the chat cache is persisted from several
        // coroutines), and the loser's ATOMIC_MOVE threw NoSuchFileException out
        // of a supervisor-launched coroutine — the process died (seen on the
        // phone: chat-cache/e986173276e4.chat.json.tmp, 2026-09-28 14:14).
        val temp = File(file.parentFile, file.name + "." + UUID.randomUUID() + ".tmp")
        temp.writeText(text)
        runCatching { Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE) }
            .getOrElse {
                runCatching { Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING) }
                    .onFailure { temp.delete() }
            }
        Unit
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
    override val secrets: SecretStore = AndroidKeystoreSecretStore(context)
    override fun chatPersistence(serverUrl: String): ChatPersistence = AndroidChatPersistence(File(context.filesDir, "chat-cache"), serverUrl)

    override val appVersion: String = runCatching {
        @Suppress("DEPRECATION")
        context.packageManager.getPackageInfo(context.packageName, 0).versionName.orEmpty()
    }.getOrDefault("")

    @Volatile
    var foreground: Boolean = false
    override val inForeground: Boolean get() = foreground

    /** The visible activity, kept so [exitApp] can close the app from the shared UI. */
    @Volatile
    var activity: Activity? = null

    private val notifications = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    override fun httpClient(baseUrl: String?): HttpClient = HttpClient(OkHttp) {
        engine {
            config {
                lanSocketFactory(baseUrl)?.let { socketFactory(it) }
                connectTimeout(10, TimeUnit.SECONDS)
                readTimeout(0, TimeUnit.MILLISECONDS)
                retryOnConnectionFailure(true)
            }
        }
    }

    override fun networkAvailable(): Flow<Boolean> = callbackFlow {
        val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        fun current() = connectivity.hasUsableNetwork()
        trySend(current())
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { trySend(true) }
            override fun onLost(network: Network) { trySend(current()) }
            override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) { trySend(current()) }
            override fun onUnavailable() { trySend(current()) }
        }
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
            .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
            .build()
        connectivity.registerNetworkCallback(request, callback)
        awaitClose { runCatching { connectivity.unregisterNetworkCallback(callback) } }
    }

    private fun lanSocketFactory(baseUrl: String?): SocketFactory? {
        val host = runCatching { URI(baseUrl ?: return null).host }.getOrNull() ?: return null
        if (!isLocalNetworkIpv4(host)) return null
        val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val wifi = connectivity.allNetworks.firstOrNull { network ->
            connectivity.getNetworkCapabilities(network)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        } ?: return null
        return wifi.socketFactory
    }

    private fun ConnectivityManager.hasUsableNetwork(): Boolean = allNetworks.any { network ->
        val caps = getNetworkCapabilities(network) ?: return@any false
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
            || caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
            || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
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

    /**
     * «Выход»: the watch service goes first, then the whole process — without
     * the kill the coroutines would keep polling the server in the background
     * until the system gets around to reclaiming the process.
     */
    override fun exitApp() {
        setBackgroundWatch(0)
        activity?.finishAffinity()
        exitProcess(0)
    }

    override fun openUrl(url: String) {
        runCatching {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    override suspend fun saveFile(name: String, bytes: ByteArray, mimeType: String?, open: Boolean): Result<String> = withContext(Dispatchers.IO) {
        runCatching {
            val safeName = name.substringAfterLast('/').substringAfterLast('\\').ifBlank { "taskbridge-file" }
            val resolver = context.contentResolver
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, safeName)
                put(MediaStore.MediaColumns.MIME_TYPE, mimeType ?: "application/octet-stream")
                if (Build.VERSION.SDK_INT >= 29) put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("Не удалось создать файл в Downloads")
            try {
                resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw IllegalStateException("Не удалось открыть файл для записи")
                if (Build.VERSION.SDK_INT >= 29) {
                    values.clear()
                    values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                    resolver.update(uri, values, null, null)
                }
                if (open) {
                    val intent = Intent(Intent.ACTION_VIEW)
                        .setDataAndType(uri, mimeType ?: "application/octet-stream")
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    context.startActivity(intent)
                }
                "Сохранено в Загрузки: $safeName"
            } catch (e: Throwable) {
                resolver.delete(uri, null, null)
                throw e
            }
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

/** A screenshot or an image copied in another app sits in the clipboard as a content URI. */
@Composable
actual fun rememberClipboardFiles(): () -> List<UploadFile> {
    val context = LocalContext.current
    return remember(context) {
        {
            val clip = (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip
            if (clip == null) emptyList()
            else (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }.mapNotNull { readUri(context, it) }
        }
    }
}

// Перетаскивание файлов из проводника — десктопная механика; на телефоне
// вложения идут через кнопку скрепки и буфер обмена.
actual fun hasFileDrop(event: DragAndDropEvent): Boolean = false

actual fun dragDroppedFiles(event: DragAndDropEvent): List<UploadFile> = emptyList()

actual fun androidx.compose.ui.Modifier.fileDropTarget(onFiles: (List<UploadFile>) -> Unit): androidx.compose.ui.Modifier = this

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
