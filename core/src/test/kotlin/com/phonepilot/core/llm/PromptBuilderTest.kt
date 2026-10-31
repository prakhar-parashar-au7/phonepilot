package com.phonepilot.core.llm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PromptBuilderTest {
    @Test fun systemMessageCarriesSchemaAndRules() {
        val msgs = PromptBuilder.build(LlmContext("t", "com.x", "#0 [tap] \"a\" (1,1)", emptyList()))
        assertEquals("system", msgs.first().role)
        assertTrue(msgs.first().content.contains("\"action\":\"tap\""))
        assertTrue(msgs.first().content.lowercase().contains("current screen"))
    }

    @Test fun userMessageCarriesTaskTreeAndHistory() {
        val ctx = LlmContext(
            task = "open youtube",
            foregroundPackage = "com.launcher",
            serializedTree = "#0 [tap] \"YouTube\" (5,5)",
            history = listOf(Step("""{"action":"open","pkg":"com.x"}""", "ok")),
        )
        val user = PromptBuilder.build(ctx).last()
        assertEquals("user", user.role)
        assertTrue(user.content.contains("open youtube"))
        assertTrue(user.content.contains("com.launcher"))
        assertTrue(user.content.contains("#0 [tap] \"YouTube\" (5,5)"))
        assertTrue(user.content.contains("ok"))
    }
}
