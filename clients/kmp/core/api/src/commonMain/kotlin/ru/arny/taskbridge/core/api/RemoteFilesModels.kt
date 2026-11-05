package ru.arny.taskbridge.core.api

import kotlinx.serialization.Serializable

@Serializable
data class RemoteFileRoot(
    val id: String,
    val name: String = id,
    val available: Boolean = false,
    val enabled: Boolean = false,
    val revoked: Boolean = false,
    val canBrowse: Boolean = false,
    val canPreview: Boolean = false,
    val canAttach: Boolean = false,
    val agentCanRead: Boolean = false,
    val allowModelTransfer: Boolean = false,
)

@Serializable
data class RemoteFileEntry(
    val name: String,
    val path: String,
    val type: String,
    val size: Long? = null,
    val modifiedAt: String? = null,
    val mimeType: String? = null,
    val previewAvailable: Boolean = false,
)

@Serializable
data class RemoteFileListing(
    val rootId: String,
    val path: String,
    val parent: String? = null,
    val entries: List<RemoteFileEntry> = emptyList(),
    val nextCursor: String? = null,
    val truncated: Boolean = false,
)

@Serializable
data class ExternalReadRequest(
    val id: String,
    val projectId: String,
    val requestedPath: String? = null,
    val requestedPermissions: List<String> = emptyList(),
    val status: String,
    val createdAt: String? = null,
    val expiresAt: String? = null,
)

@Serializable
data class ExternalReadSettings(
    val revision: Long = 0,
    val localOperator: Boolean = false,
    val roots: List<RemoteFileRoot> = emptyList(),
    val requests: List<ExternalReadRequest> = emptyList(),
)

@Serializable
data class RemoteFilePreview(
    val name: String,
    val mimeType: String,
    val image: Boolean = false,
    val base64: String? = null,
    val text: String? = null,
)

@Serializable
data class RemoteFileSearch(
    val entries: List<RemoteFileEntry> = emptyList(),
    val checkedDirectories: Int = 0,
    val truncated: Boolean = false,
)
