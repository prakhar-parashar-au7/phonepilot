package com.phonepilot.app

import com.phonepilot.core.model.UiNode

object LocalActionSafety {
    private val sensitiveField = Regex("password|otp|one[ -]?time|card|cvv|upi|payment|bank|login|credential", RegexOption.IGNORE_CASE)

    fun canType(node: UiNode): Boolean = node.editable && !sensitiveField.containsMatchIn(node.label.orEmpty())
}
