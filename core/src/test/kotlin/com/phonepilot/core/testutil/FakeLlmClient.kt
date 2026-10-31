package com.phonepilot.core.testutil

import com.phonepilot.core.llm.LlmClient
import com.phonepilot.core.llm.LlmContext
import com.phonepilot.core.model.AgentAction

class FakeLlmClient(private val script: List<AgentAction>) : LlmClient {
    val seen = mutableListOf<LlmContext>()
    private var i = 0
    override suspend fun nextAction(context: LlmContext): AgentAction {
        seen += context
        check(i < script.size) { "FakeLlmClient asked for action ${i + 1} but script has ${script.size}" }
        return script[i++]
    }
}
