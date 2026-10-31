package com.phonepilot.app

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SetupStateTest {
    @Test fun readyOnlyWhenEveryManualCapabilityIsAvailable() {
        assertFalse(SetupState(true, true, true, false).ready)
        assertTrue(SetupState(true, true, true, true).ready)
    }
}
