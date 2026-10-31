package com.phonepilot.app

import com.phonepilot.core.model.AgentAction

object VoiceCommand {
    private val packages = mapOf(
        "whatsapp" to "com.whatsapp",
        "blinkit" to "com.grofers.customerapp",
        "blinked" to "com.grofers.customerapp",
        "blink it" to "com.grofers.customerapp",
        "paytm" to "net.one97.paytm",
        "youtube" to "com.google.android.youtube",
    )

    fun openPackage(transcript: String): String? {
        val normalized = transcript.trim().lowercase()
        if (!normalized.startsWith("open ")) return null
        return packages.entries.firstOrNull { normalized.contains(it.key) }?.value
    }

    fun localAction(transcript: String): AgentAction.OpenApp? {
        val normalized = transcript.trim().lowercase().removeSuffix(".")
        val packageName = packages.entries.firstOrNull { normalized == "open ${it.key}" }?.value
        return packageName?.let(AgentAction::OpenApp)
    }

    fun allowedPackages(): Set<String> = packages.values.toSet()
}
