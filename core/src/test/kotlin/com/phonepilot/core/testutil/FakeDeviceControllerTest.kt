package com.phonepilot.core.testutil

import com.phonepilot.core.model.*
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

class FakeDeviceControllerTest {
    private fun snap(pkg: String) = UiSnapshot(pkg, UiNode(null, null, "r", false, false, Bounds(0,0,1,1), emptyList()))

    @Test fun servesSnapshotsInOrderThenRepeatsLast() = runTest {
        val d = FakeDeviceController(listOf(snap("a"), snap("b")))
        assertEquals("a", d.snapshot().foregroundPackage)
        assertEquals("b", d.snapshot().foregroundPackage)
        assertEquals("b", d.snapshot().foregroundPackage)
    }

    @Test fun recordsExecutedActions() = runTest {
        val d = FakeDeviceController(listOf(snap("a")))
        d.execute(AgentAction.TapElement(2))
        assertEquals(listOf<AgentAction>(AgentAction.TapElement(2)), d.executed)
    }
}
