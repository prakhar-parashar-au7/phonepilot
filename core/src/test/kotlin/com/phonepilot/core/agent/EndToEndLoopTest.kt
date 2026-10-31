package com.phonepilot.core.agent

import com.phonepilot.core.llm.OpenAiCompatibleLlmClient
import com.phonepilot.core.model.*
import com.phonepilot.core.testutil.FakeDeviceController
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

class EndToEndLoopTest {
    private val server = MockWebServer()
    @AfterTest fun tearDown() = server.shutdown()
    private fun body(c: String) =
        """{"choices":[{"message":{"content":${"\"" + c.replace("\"","\\\"") + "\""}}}]}"""

    @Test fun completesOpenYouTubeTask() = runTest {
        server.enqueue(MockResponse().setBody(body("""{"action":"open","pkg":"com.google.android.youtube"}""")))
        server.enqueue(MockResponse().setBody(body("""{"action":"done","summary":"YouTube opened"}""")))
        val device = FakeDeviceController(listOf(
            UiSnapshot("com.launcher", UiNode("YouTube", null, "b", true, false, Bounds(0,0,10,10), emptyList())),
            UiSnapshot("com.google.android.youtube", UiNode(null, null, "r", false, false, Bounds(0,0,1,1), emptyList())),
        ))
        val llm = OpenAiCompatibleLlmClient(server.url("/v1").toString(), "k", "free/model")
        val events = mutableListOf<AgentEvent>()

        val outcome = Orchestrator(device, llm).run("open the YouTube app") { events += it }

        assertEquals(Outcome.COMPLETED, outcome)
        assertEquals(listOf<AgentAction>(AgentAction.OpenApp("com.google.android.youtube")), device.executed)
        assertEquals(AgentEvent.Finished(Outcome.COMPLETED), events.last())
    }
}
