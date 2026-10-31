package com.phonepilot.app

import java.net.URI

data class BackendConfig(val workerUrl: String, val deviceToken: String) {
    val isValid: Boolean
        get() {
            val uri = runCatching { URI(workerUrl) }.getOrNull() ?: return false
            return uri.scheme == "https" && !uri.host.isNullOrBlank() && deviceToken.isNotBlank()
        }
}
