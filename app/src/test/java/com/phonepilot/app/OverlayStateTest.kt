package com.phonepilot.app

import kotlin.test.Test
import kotlin.test.assertEquals

class OverlayStateTest {
    @Test fun stopClearsActiveStatus() {
        assertEquals(OverlayState.Idle, OverlayState.Working("Listening").stop())
    }

    @Test fun transientStatusExpiresAfterItsTimeout() {
        val status = OverlayState.Working("PhonePilot: ERROR", shownAtMillis = 1_000, timeoutMillis = 2_500)

        assertEquals(OverlayState.Working("PhonePilot: ERROR", shownAtMillis = 1_000, timeoutMillis = 2_500), status.at(3_499))
        assertEquals(OverlayState.Idle, status.at(3_500))
    }
}
