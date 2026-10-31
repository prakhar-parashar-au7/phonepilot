package com.phonepilot.core.llm

import com.phonepilot.core.model.AgentAction
import com.phonepilot.core.model.ScrollDirection
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class ActionJsonTest {
    @Test fun askActionReturnsQuestionAndConsequence() {
        assertEquals(
            AgentAction.AskUser("Send it?", "This sends a WhatsApp message"),
            ActionJson.parse("{\"action\":\"ask\",\"question\":\"Send it?\",\"consequence\":\"This sends a WhatsApp message\"}"),
        )
    }
    @Test fun parsesEachActionType() {
        assertEquals(AgentAction.OpenApp("com.x"), ActionJson.parse("""{"action":"open","pkg":"com.x"}"""))
        assertEquals(AgentAction.TapElement(7), ActionJson.parse("""{"action":"tap","index":7}"""))
        assertEquals(AgentAction.TypeText(2, "milk"), ActionJson.parse("""{"action":"type","index":2,"text":"milk"}"""))
        assertEquals(AgentAction.Scroll(ScrollDirection.DOWN), ActionJson.parse("""{"action":"scroll","direction":"down"}"""))
        assertEquals(AgentAction.PressBack, ActionJson.parse("""{"action":"back"}"""))
        assertEquals(AgentAction.TaskComplete("done"), ActionJson.parse("""{"action":"done","summary":"done"}"""))
    }

    @Test fun stripsFencesAndProse() {
        val raw = "Sure!\n```json\n{\"action\":\"tap\",\"index\":1}\n```"
        assertEquals(AgentAction.TapElement(1), ActionJson.parse(raw))
    }

    @Test fun rejectsUnknownAction() {
        assertFailsWith<ActionParseException> { ActionJson.parse("""{"action":"fly"}""") }
    }
}
