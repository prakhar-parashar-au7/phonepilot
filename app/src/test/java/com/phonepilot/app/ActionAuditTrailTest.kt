package com.phonepilot.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

class ActionAuditTrailTest {
    @Test fun `trace excludes task labels and typed text`() {
        val trail = ActionAuditTrail()

        trail.record("type_text", "com.whatsapp", 7, "executed", "ok")

        assertFalse(trail.records().toString().contains("private message"))
    }

    @Test fun `trace keeps at most fifty records`() {
        val trail = ActionAuditTrail()

        repeat(51) { trail.record("tap", "com.whatsapp", it, "executed", "ok") }

        assertEquals(50, trail.records().size)
    }
}
