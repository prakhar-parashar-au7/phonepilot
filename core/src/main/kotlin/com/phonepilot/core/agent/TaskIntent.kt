package com.phonepilot.core.agent

/** A deliberately narrow interpretation of the user's original spoken request. */
data class TaskIntent(
    val explicitSend: Boolean = false,
    val recipient: String? = null,
) {
    fun matchesVisibleRecipient(labels: Collection<String?>): Boolean = explicitSend && recipient != null &&
        labels.any { label -> label?.contains(recipient, ignoreCase = true) == true }

    companion object {
        private val explicitSend = Regex(
            """^\s*(?:please\s+)?(?:send|message|text)\s+(?:to\s+)?([^\s:,]+)(?:\s*[:,]\s*|\s+).+$""",
            RegexOption.IGNORE_CASE,
        )
        private val ambiguousRecipients = setOf("a", "an", "the", "it", "this", "that", "message", "text")

        fun from(task: String): TaskIntent {
            val recipient = explicitSend.find(task)?.groupValues?.get(1)?.trim()
                ?.takeUnless { it.lowercase() in ambiguousRecipients }
                ?: return TaskIntent()
            return TaskIntent(explicitSend = true, recipient = recipient)
        }
    }
}
