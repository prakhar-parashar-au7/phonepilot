package com.phonepilot.core.llm

import com.phonepilot.core.model.AgentAction
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

class OpenAiCompatibleLlmClientTest {
    private val server = MockWebServer()
    private fun body(content: String) =
        """{"choices":[{"message":{"role":"assistant","content":${quote(content)}}}]}"""
    private fun quote(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

    @AfterTest fun tearDown() = server.shutdown()

    private fun client() = OpenAiCompatibleLlmClient(
        baseUrl = server.url("/v1").toString(), apiKey = "k", model = "test/model")
    private val ctx = LlmContext("t", "com.x", "#0 [tap] \"a\" (1,1)", emptyList())

    @Test fun parsesActionFromResponse() = runTest {
        server.enqueue(MockResponse().setBody(body("""{"action":"tap","index":0}""")))
        assertEquals(AgentAction.TapElement(0), client().nextAction(ctx))
    }

    @Test fun retriesOnMalformedThenSucceeds() = runTest {
        server.enqueue(MockResponse().setBody(body("I cannot help")))
        server.enqueue(MockResponse().setBody(body("""{"action":"done","summary":"ok"}""")))
        assertEquals(AgentAction.TaskComplete("ok"), client().nextAction(ctx))
        assertEquals(2, server.requestCount)
    }
}
