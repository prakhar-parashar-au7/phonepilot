package com.phonepilot.app

import com.phonepilot.core.model.Bounds
import com.phonepilot.core.model.UiNode
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class LocalActionSafetyTest {
    private fun field(label: String, editable: Boolean = true) = UiNode(label, null, "EditText", true, editable, Bounds(0, 0, 1, 1), emptyList())
    @Test fun `editable search permits automatic typing`() = assertTrue(LocalActionSafety.canType(field("Search products")))
    @Test fun `password otp payment banking and login reject typing`() {
        listOf("Password", "Enter OTP", "Card number", "UPI payment", "Login email").forEach { assertFalse(LocalActionSafety.canType(field(it))) }
    }
}
