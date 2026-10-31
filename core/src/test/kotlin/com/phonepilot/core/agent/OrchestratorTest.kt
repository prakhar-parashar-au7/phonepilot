package com.phonepilot.core.agent

import com.phonepilot.core.model.*
import com.phonepilot.core.llm.LlmClient
import com.phonepilot.core.llm.LlmContext
import com.phonepilot.core.llm.LlmTransportException
import com.phonepilot.core.testutil.FakeDeviceController
import com.phonepilot.core.testutil.FakeLlmClient
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

class OrchestratorTest {
    private fun snap(pkg: String) =
        UiSnapshot(pkg, UiNode("Search", null, "b", true, false, Bounds(0, 0, 10, 10), emptyList()))

    @Test fun executesActionsThenCompletes() = runTest {
        val device = FakeDeviceController(listOf(snap("com.x")))
        val llm = FakeLlmClient(listOf(AgentAction.TapElement(0), AgentAction.TaskComplete("done")))
        val events = mutableListOf<AgentEvent>()
        val outcome = Orchestrator(device, llm).run("task") { events += it }
        assertEquals(Outcome.COMPLETED, outcome)
        assertEquals(listOf<AgentAction>(AgentAction.TapElement(0)), device.executed)
        assertEquals(UiActionSession.capture(snap("com.x")), device.executedSessions.single())
    }

    @Test fun secondCallSeesFirstActionInHistory() = runTest {
        val device = FakeDeviceController(listOf(snap("com.x")))
        val llm = FakeLlmClient(listOf(AgentAction.TapElement(0), AgentAction.TaskComplete("done")))
        Orchestrator(device, llm).run("task")
        assertEquals(1, llm.seen[1].history.size)
        assertEquals("ok", llm.seen[1].history.first().resultMessage)
    }

    @Test fun stopsAtStepCap() = runTest {
        val device = FakeDeviceController(listOf(snap("com.x")))
        val llm = FakeLlmClient(List(10) { AgentAction.TapElement(0) })
        assertEquals(Outcome.STEP_CAP, Orchestrator(device, llm, maxSteps = 3).run("task"))
        assertEquals(3, device.executed.size)
    }

    @Test fun askUserStopsLoop() = runTest {
        val device = FakeDeviceController(listOf(snap("com.x")))
        val llm = FakeLlmClient(listOf(AgentAction.AskUser("which one?", "Needs your choice")))
        assertEquals(Outcome.ASKED_USER, Orchestrator(device, llm).run("task"))
    }

    @Test fun reportsSafeTransportFailureBeforeReturningError() = runTest {
        val device = FakeDeviceController(listOf(snap("com.x")))
        val llm = object : LlmClient {
            override suspend fun nextAction(context: LlmContext): AgentAction =
                throw LlmTransportException("PhonePilot Worker returned HTTP 502")
        }
        val events = mutableListOf<AgentEvent>()

        assertEquals(Outcome.ERROR, Orchestrator(device, llm).run("task") { events += it })
        assertEquals(AgentEvent.Failed("PhonePilot Worker returned HTTP 502"), events.first())
    }
}
