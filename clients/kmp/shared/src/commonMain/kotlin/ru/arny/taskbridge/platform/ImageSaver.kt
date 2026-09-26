package ru.arny.taskbridge.platform

import androidx.compose.runtime.Composable

/** Saves authenticated original bytes, never a browser URL or a re-encoded bitmap. */
@Composable
internal expect fun rememberImageSaver(name: String, bytes: ByteArray, onResult: (String) -> Unit): () -> Unit
