package com.phonepilot.app

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SensitiveContentPolicyTest {
    @Test fun blocksOtpAndPasswordBeforeNetworkRequest() {
        assertTrue(SensitiveContentPolicy.containsSensitive("my OTP is 123456"))
        assertTrue(SensitiveContentPolicy.containsSensitive("password: secret"))
        assertFalse(SensitiveContentPolicy.containsSensitive("open WhatsApp"))
    }

    @Test fun allowsOrdinaryUpiPromotionsButBlocksAnUpiIdentifier() {
        assertFalse(SensitiveContentPolicy.containsSensitive("Save more with UPI offers"))
        assertTrue(SensitiveContentPolicy.containsSensitive("My UPI ID is prakhar@bank"))
    }
}
