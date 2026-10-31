package com.phonepilot.core.agent

import com.phonepilot.core.model.Bounds
import com.phonepilot.core.model.UiNode
import com.phonepilot.core.model.UiSnapshot
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class UiActionSessionTest {
    private fun snapshot(label: String, bounds: Bounds = Bounds(0, 0, 20, 40), editable: Boolean = false, pkg: String = "com.example") =
        UiSnapshot(pkg, UiNode(null, null, "root", false, false, Bounds(0, 0, 100, 100), listOf(
            UiNode(label, null, "android.widget.Button", true, editable, bounds, emptyList()),
        )))

    @Test fun `matching indexed element is accepted`() {
        val session = UiActionSession.capture(snapshot("Search"))
        assertTrue(session.matches(0, snapshot("Search")))
    }

    @Test fun `changed label bounds package or edit state rejects index`() {
        val session = UiActionSession.capture(snapshot("Search"))
        assertFalse(session.matches(0, snapshot("Buy")))
        assertFalse(session.matches(0, snapshot("Search", Bounds(1, 0, 20, 40))))
        assertFalse(session.matches(0, snapshot("Search", editable = true)))
        assertFalse(session.matches(0, snapshot("Search", pkg = "com.other")))
    }
}
