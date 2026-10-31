package com.phonepilot.app

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class BackendConfigTest {
    @Test fun acceptsOnlyHttpsWorkerConfiguration() {
        assertTrue(BackendConfig("https://phonepilot-agent.example.workers.dev", "device-token").isValid)
        assertFalse(BackendConfig("http://example.test", "device-token").isValid)
        assertFalse(BackendConfig("https://example.test", "").isValid)
    }
}
