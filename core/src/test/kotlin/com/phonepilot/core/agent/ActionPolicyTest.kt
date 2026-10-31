package com.phonepilot.core.agent

import com.phonepilot.core.model.AgentAction
import com.phonepilot.core.model.Bounds
import com.phonepilot.core.model.UiNode
import com.phonepilot.core.model.UiSnapshot
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

class ActionPolicyTest {
    private val policy = ActionPolicy(setOf("com.allowed"))

    @Test fun staleTapIsRejected() {
        assertEquals(
            PolicyDecision.Reject("element #9 is not in current snapshot"),
            policy.decide(AgentAction.TapElement(9), snapshotWithLabel("Open")),
        )
    }

    @Test fun sendLikeTapRequiresConfirmation() {
        val result = policy.decide(AgentAction.TapElement(0), snapshotWithLabel("Send"))
        assertIs<PolicyDecision.Confirm>(result)
        assertEquals("Confirm Send", result.question)
    }

    @Test fun sendButtonIsBlockedWithoutExplicitRecipient() {
        assertIs<PolicyDecision.Confirm>(
            policy.decide(AgentAction.TapElement(0), snapshotWithLabel("Send"), TaskIntent(false, null)),
        )
    }

    @Test fun matchingSendButtonMayExecuteForExplicitNamedRecipient() {
        val snapshot = UiSnapshot(
            "com.allowed",
            UiNode(
                null,
                null,
                "Layout",
                false,
                false,
                Bounds(0, 0, 10, 10),
                listOf(
                    UiNode("Shikhar", null, "TextView", false, false, Bounds(0, 0, 10, 10), emptyList()),
                    UiNode("Send", null, "Button", true, false, Bounds(0, 10, 10, 20), emptyList()),
                ),
            ),
        )
        assertEquals(
            PolicyDecision.Execute,
            policy.decide(AgentAction.TapElement(1), snapshot, TaskIntent(true, "Shikhar")),
        )
    }

    @Test fun packageOutsideAllowlistIsRejected() {
        assertEquals(
            PolicyDecision.Reject("app is not allowed: com.other"),
            policy.decide(AgentAction.OpenApp("com.other"), snapshotWithLabel("Open")),
        )
    }

    private fun snapshotWithLabel(label: String) = UiSnapshot(
        "com.allowed",
        UiNode(label, null, "Button", true, false, Bounds(0, 0, 10, 10), emptyList()),
    )
}
