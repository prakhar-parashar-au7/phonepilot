package com.phonepilot.core.model

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class UiNodeTest {
    @Test fun boundsCenter() {
        val b = Bounds(0, 0, 100, 200)
        assertEquals(50, b.centerX)
        assertEquals(100, b.centerY)
    }

    @Test fun labelPrefersTextThenContentDesc() {
        assertEquals("Search", node(text = "Search", contentDesc = "x").label)
        assertEquals("Send", node(text = null, contentDesc = "Send").label)
        assertNull(node(text = "  ", contentDesc = null).label)
    }

    private fun node(text: String?, contentDesc: String?) =
        UiNode(text, contentDesc, "android.widget.Button", true, false, Bounds(0, 0, 1, 1), emptyList())
}
