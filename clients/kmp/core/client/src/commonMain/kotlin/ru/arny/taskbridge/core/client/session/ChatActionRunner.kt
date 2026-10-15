package ru.arny.taskbridge.core.client.session

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import ru.arny.taskbridge.core.api.ApiError
import ru.arny.taskbridge.core.api.ApiException

/** Action admission and UI activity, independent of history reduction and delivery retry. */
internal class ChatActionRunner(
    private val scope: CoroutineScope,
    private val busyChanged: (Set<String>) -> Unit,
    private val notice: (String) -> Unit,
    private val failed: (ApiError) -> Unit,
    private val refresh: () -> Unit,
) {
    private val mutex = Mutex()
    private val active = mutableMapOf<String, Int>()

    fun run(key: String, startNotice: String? = null, concurrent: Boolean = false, block: suspend () -> Unit) {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            val admitted = mutex.withLock {
                if (!concurrent && key in active) false else {
                    active[key] = (active[key] ?: 0) + 1
                    busyChanged(active.keys.toSet())
                    true
                }
            }
            if (!admitted) return@launch
            try {
                startNotice?.let(notice)
                block()
                refresh()
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (failure: ApiException) {
                failed(failure.error)
            } finally {
                withContext(NonCancellable) {
                    mutex.withLock {
                        val remaining = active.getValue(key) - 1
                        if (remaining == 0) active.remove(key) else active[key] = remaining
                        busyChanged(active.keys.toSet())
                    }
                }
            }
        }
    }
}
