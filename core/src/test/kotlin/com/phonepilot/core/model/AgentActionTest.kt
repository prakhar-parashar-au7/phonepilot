package com.phonepilot.core.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AgentActionTest {
    @Test fun actionsCarryTheirData() {
        assertEquals("com.x", (AgentAction.OpenApp("com.x")).pkg)
        assertEquals(7, (AgentAction.TapElement(7)).index)
        val t = AgentAction.TypeText(3, "milk")
        assertEquals(3, t.index); assertEquals("milk", t.text)
        assertTrue(AgentAction.PressBack is AgentAction)
    }

    @Test fun resultHoldsOutcome() {
        val r = ActionResult(success = false, message = "no such element")
        assertEquals(false, r.success)
        assertEquals("no such element", r.message)
    }
}
