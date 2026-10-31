package com.phonepilot.core.testutil

import com.phonepilot.core.llm.LlmContext
import com.phonepilot.core.model.AgentAction
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

class FakeLlmClientTest {
    @Test fun returnsScriptedActionsAndRecordsContext() = runTest {
        val f = FakeLlmClient(listOf(AgentAction.TapElement(1), AgentAction.TaskComplete("x")))
        val ctx = LlmContext("task", "com.x", "#0 [tap] \"a\" (1,1)", emptyList())
        assertEquals(AgentAction.TapElement(1), f.nextAction(ctx))
        assertEquals(AgentAction.TaskComplete("x"), f.nextAction(ctx))
        assertEquals(2, f.seen.size)
        assertEquals("task", f.seen.first().task)
    }
}
