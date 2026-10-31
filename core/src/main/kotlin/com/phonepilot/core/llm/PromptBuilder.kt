package com.phonepilot.core.llm

data class ChatMessage(val role: String, val content: String)

object PromptBuilder {
    fun build(context: LlmContext): List<ChatMessage> {
        val system = buildString {
            appendLine("You are PhonePilot, an agent that operates an Android phone to complete the user's task.")
            appendLine("You are given the task, the current foreground app, and a list of on-screen elements.")
            appendLine("Each element has an index (#N), a kind ([tap]/[type]/[text]), a label, and screen coordinates.")
            appendLine("Only use indices that are present in the CURRENT screen listing. Indices change every step.")
            appendLine("Use ask before any consequential action: sending, calling, buying, paying, deleting, sharing, or allowing a permission.")
            appendLine("Choose the single best next action. When the task is fully done, use the \"done\" action.")
            appendLine()
            append(ActionJson.schemaDoc())
        }
        val user = buildString {
            appendLine("TASK: ${context.task}")
            appendLine("FOREGROUND APP: ${context.foregroundPackage}")
            appendLine()
            appendLine("SCREEN ELEMENTS:")
            appendLine(context.serializedTree.ifBlank { "(no interactable elements found)" })
            if (context.history.isNotEmpty()) {
                appendLine()
                appendLine("HISTORY (most recent last):")
                context.history.forEach { appendLine("- ${it.action} -> ${it.resultMessage}") }
            }
        }
        return listOf(ChatMessage("system", system), ChatMessage("user", user))
    }
}
