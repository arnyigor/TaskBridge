package ru.arny.taskbridge.core.client.session

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** One composer's persistence policy; calls belong to the composer's UI scope. */
class DraftAutosave(
    private val scope: CoroutineScope,
    initial: String,
    private val save: (String) -> Unit,
    private val delayMs: Long = 400,
) {
    private var current = initial
    private var persisted = initial
    private var pending: Job? = null
    private var closed = false

    fun update(text: String) {
        if (closed || text == current) return
        current = text
        pending?.cancel()
        pending = scope.launch {
            delay(delayMs)
            flush()
        }
    }

    /** Also accepts the latest UI text if its state observer has not run yet. */
    fun flush(text: String = current) {
        if (closed) return
        pending?.cancel()
        pending = null
        current = text
        if (text != persisted) {
            save(text)
            persisted = text
        }
    }

    fun close(text: String = current) {
        flush(text)
        closed = true
    }
}
