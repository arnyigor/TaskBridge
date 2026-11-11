package ru.arny.taskbridge.ui.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import ru.arny.taskbridge.ui.theme.AppIcons
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Что делает одна кнопка питания: всё отличие между «выключить» и «перезагрузить»
 * — тексты и вызов сервера, а отсчёт, отмена и показ ошибки у них одни и те же.
 */
private class PowerRequest(
    val idleTitle: String,
    val countdownTitle: (Int) -> String,
    val sendingTitle: String,
    val confirmLabel: String,
    val cancelLabel: String,
    val seconds: Int,
    val run: suspend () -> Unit,
)

/**
 * «Питание и подключение»: клиентские действия и кнопки, которые гасят саму
 * машину с сервером.
 *
 * Диалоги живут здесь же, рядом с кнопками: перенос состояний в экран растягивал
 * его на сотню строк, а сами диалоги были двумя копиями одного поведения.
 *
 * @param onModalChange сообщает экрану, открыт ли модальный диалог: пока он
 * открыт, фоновый опрос статуса приостанавливается.
 */
@Composable
internal fun PowerSection(
    kind: String,
    shutdown: suspend () -> Unit,
    reboot: suspend () -> Unit,
    onDisconnect: () -> Unit,
    onExit: () -> Unit,
    onModalChange: (Boolean) -> Unit = {},
    /** Сколько секунд идёт отсчёт: 10 на экране, 1 в тесте. */
    countdownSeconds: Int = 10,
) {
    var confirmDisconnect by remember { mutableStateOf(false) }
    var confirmExit by remember { mutableStateOf(false) }
    var powerRequest by remember { mutableStateOf<PowerRequest?>(null) }

    LaunchedEffect(confirmDisconnect, confirmExit, powerRequest) {
        onModalChange(confirmDisconnect || confirmExit || powerRequest != null)
    }

    Text(
        "Уведомления приходят, пока приложение запущено; на Android — и в свёрнутом виде, пока агент работает.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 16.dp),
    )
    Spacer(Modifier.height(12.dp))
    OutlinedButton(onClick = { confirmDisconnect = true }, modifier = Modifier.padding(horizontal = 16.dp)) {
        Icon(AppIcons.Logout, null, Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text("Отключиться от компьютера")
    }
    if (kind == "android") {
        // Полный выход, а не «отключиться»: закрывает процесс целиком, чтобы
        // за пределами домашнего Wi-Fi ничего не опрашивало сервер и не
        // держало службу. Адрес и вход остаются сохранёнными.
        Spacer(Modifier.height(12.dp))
        OutlinedButton(onClick = { confirmExit = true }, modifier = Modifier.padding(horizontal = 16.dp)) {
            Icon(AppIcons.Close, null, Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("Выход из приложения")
        }
    }
    // Клиент и машина — разные вещи: «Отключиться» и «Выход» касаются только
    // этого приложения, кнопки ниже гасят сам компьютер с сервером. Раньше они
    // стояли в одном ряду одинаковых кнопок без всякой границы.
    HorizontalDivider(Modifier.padding(horizontal = 16.dp, vertical = 10.dp))
    Text(
        "Ниже — управление самим компьютером с сервером, а не этим приложением.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 16.dp),
    )
    // Машина, на которой живёт сервер, выключается целиком — и с телефона,
    // и из десктопного приложения: действие адресовано серверу, а не
    // устройству, на котором рисуется экран.
    Spacer(Modifier.height(12.dp))
    OutlinedButton(
        onClick = {
            powerRequest = PowerRequest(
                idleTitle = "Выключить компьютер?",
                countdownTitle = { "Компьютер выключится через $it…" },
                sendingTitle = "Выключаю компьютер…",
                confirmLabel = "Выключить",
                cancelLabel = "Отменить выключение",
                seconds = countdownSeconds,
                run = shutdown,
            )
        },
        modifier = Modifier.padding(horizontal = 16.dp),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
    ) {
        Icon(AppIcons.Power, null, Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text("Выключить компьютер")
    }
    Spacer(Modifier.height(12.dp))
    OutlinedButton(
        onClick = {
            powerRequest = PowerRequest(
                idleTitle = "Перезагрузить компьютер?",
                countdownTitle = { "Компьютер перезагрузится через $it…" },
                sendingTitle = "Перезагружаю компьютер…",
                confirmLabel = "Перезагрузить",
                cancelLabel = "Отменить перезагрузку",
                seconds = countdownSeconds,
                run = reboot,
            )
        },
        modifier = Modifier.padding(horizontal = 16.dp),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
    ) {
        Icon(AppIcons.Power, null, Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text("Перезагрузить компьютер")
    }

    if (confirmDisconnect) {
        AlertDialog(
            onDismissRequest = { confirmDisconnect = false },
            title = { Text("Отключиться?") },
            text = { Text("Приложение забудет адрес и вход. Сессии на компьютере не пострадают.") },
            confirmButton = {
                TextButton(onClick = { confirmDisconnect = false; onDisconnect() }) {
                    Text("Отключиться", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { confirmDisconnect = false }) { Text("Отмена") } },
        )
    }
    if (confirmExit) {
        AlertDialog(
            onDismissRequest = { confirmExit = false },
            title = { Text("Выйти?") },
            text = { Text("Приложение закроется полностью: фоновая служба остановится и уведомления о сессиях перестанут приходить, пока вы снова его не откроете. Сессии на компьютере не пострадают.") },
            confirmButton = {
                TextButton(onClick = { confirmExit = false; onExit() }) {
                    Text("Выйти", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { confirmExit = false }) { Text("Отмена") } },
        )
    }
    powerRequest?.let { request ->
        PowerConfirmDialog(request = request, onDismiss = { powerRequest = null })
    }
}

/**
 * Отсчёт подтверждения опасного действия: спросить → N секунд (можно отменить) →
 * отправка → ошибка.
 *
 * Вынесено из диалога без Compose-разметки, чтобы поведение таймера можно было
 * проверить тестом: диалог в десктопном окне — отдельное окно, и в дереве
 * семантики теста его не видно. Таймер живёт в клиенте: если приложение умрёт,
 * команда просто не уйдёт, а не сработает без присмотра.
 */
internal class DangerConfirm(
    private val seconds: Int,
    private val scope: CoroutineScope,
    private val send: suspend () -> Unit,
    private val onSent: () -> Unit = {},
) {
    /** Сколько секунд осталось; null — отсчёт не идёт. */
    var left by mutableStateOf<Int?>(null)
        private set
    var sending by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    private var job: Job? = null

    /** Подтверждение: начать отсчёт (не отправку) заново. */
    fun start() {
        if (sending) return
        error = null
        left = seconds
        job?.cancel()
        job = scope.launch {
            while (true) {
                val remaining = left ?: return@launch
                if (remaining <= 0) break
                delay(1_000)
                left = remaining - 1
            }
            sending = true
            try {
                send()
                sending = false
                left = null
                onSent()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.message ?: "Не удалось связаться с компьютером."
                sending = false
                left = null
            }
        }
    }

    /** Отмена до отправки. Пока команда ушла, отменять уже нечего. */
    fun cancel() {
        if (sending) return
        job?.cancel()
        job = null
        left = null
    }
}

/** Окно подтверждения: показывает то, что считает [DangerConfirm]. */
@Composable
private fun PowerConfirmDialog(request: PowerRequest, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val confirm = remember(request) {
        DangerConfirm(request.seconds, scope, request.run, onSent = onDismiss)
    }
    val left = confirm.left
    val sending = confirm.sending

    AlertDialog(
        onDismissRequest = { if (!sending) onDismiss() },
        title = {
            Text(
                when {
                    sending -> request.sendingTitle
                    left != null -> request.countdownTitle(left)
                    else -> request.idleTitle
                },
            )
        },
        text = {
            when {
                sending -> Text("Команда уже ушла на компьютер.")
                left != null -> Column {
                    LinearProgressIndicator(
                        progress = { left / request.seconds.toFloat() },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(12.dp))
                    Text("Отменить можно, пока идёт отсчёт.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                else -> Text("TaskBridge остановится вместе с машиной: запущенные сессии будут прерваны. Отмена возможна только в первые ${request.seconds} секунд после подтверждения.")
            }
            confirm.error?.let { message ->
                Text(message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp))
            }
        },
        confirmButton = {
            when {
                sending -> CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                left != null -> {}
                else -> TextButton(onClick = confirm::start) {
                    Text(request.confirmLabel, color = MaterialTheme.colorScheme.error)
                }
            }
        },
        dismissButton = {
            TextButton(onClick = {
                if (left != null && !sending) confirm.cancel() else onDismiss()
            }) {
                Text(if (left != null && !sending) request.cancelLabel else "Закрыть")
            }
        },
    )
}
