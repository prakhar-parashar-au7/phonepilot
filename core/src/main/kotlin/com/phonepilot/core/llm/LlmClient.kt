package com.phonepilot.core.llm

import com.phonepilot.core.model.AgentAction

data class Step(val action: String, val resultMessage: String)

data class LlmContext(
    val task: String,
    val foregroundPackage: String,
    val serializedTree: String,
    val history: List<Step>,
)

interface LlmClient {
    suspend fun nextAction(context: LlmContext): AgentAction
}
