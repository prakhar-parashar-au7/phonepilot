package com.phonepilot.app

object SensitiveContentPolicy {
    private val markers = Regex("""\b(otp|one[ -]?time[ -]?password|password|cvv|account number|card number|credential)\b|\bupi(?:\s*(?:id|number|handle)|\s*:\s*\S+)|\b\d{6}\b""", RegexOption.IGNORE_CASE)

    fun containsSensitive(text: String): Boolean = markers.containsMatchIn(text)

    fun safeOrNull(vararg values: String): String? =
        if (values.any(::containsSensitive)) null else values.joinToString("\n")
}
