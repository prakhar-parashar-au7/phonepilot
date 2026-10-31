package com.phonepilot.core.agent

import kotlin.test.Test
import kotlin.test.assertEquals

class TaskIntentTest {
    @Test fun `send Shikhar hello has explicit send and recipient`() {
        assertEquals(TaskIntent(true, "Shikhar"), TaskIntent.from("send Shikhar hello"))
    }

    @Test fun `reply hello has no explicit recipient`() {
        assertEquals(null, TaskIntent.from("reply hello").recipient)
    }
}
