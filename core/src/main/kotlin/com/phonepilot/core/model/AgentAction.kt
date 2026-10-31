package com.phonepilot.core.model

enum class ScrollDirection { UP, DOWN }

sealed interface AgentAction {
    data class OpenApp(val pkg: String) : AgentAction
    data class TapElement(val index: Int) : AgentAction
    data class TypeText(val index: Int, val text: String) : AgentAction
    data class Scroll(val direction: ScrollDirection) : AgentAction
    data object PressBack : AgentAction
    data object PressHome : AgentAction
    data class Wait(val millis: Long) : AgentAction
    data class AskUser(val question: String, val consequence: String) : AgentAction
    data class TaskComplete(val summary: String) : AgentAction
}

data class ActionResult(val success: Boolean, val message: String)
