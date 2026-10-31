package com.phonepilot.core.perception

import com.phonepilot.core.model.Bounds
import com.phonepilot.core.model.UiNode
import com.phonepilot.core.model.UiSnapshot
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class TreeSerializerTest {
    private fun leaf(text: String?, cd: String?, clickable: Boolean, editable: Boolean) =
        UiNode(text, cd, "cls", clickable, editable, Bounds(0, 0, 20, 40), emptyList())

    @Test fun indexesOnlyInterestingNodes_andMapsThem() {
        val root = UiNode(
            null, null, "root", false, false, Bounds(0, 0, 100, 100),
            listOf(
                leaf("Search", null, true, false),
                leaf(null, null, false, false),
                leaf(null, "Send", true, false),
                leaf(null, null, false, true),
            ),
        )
        val s = TreeSerializer.serialize(UiSnapshot("com.x", root))
        assertEquals(3, s.index.size)
        assertEquals("Search", s.index[0]!!.label)
        assertEquals("Send", s.index[1]!!.label)
        assertTrue(s.index[2]!!.editable)
        assertTrue(s.text.contains("#0 [tap] \"Search\" (10,20)"))
        assertTrue(s.text.contains("#1 [tap] \"Send\" (10,20)"))
        assertTrue(s.text.contains("#2 [type]"))
    }

    @Test fun textOnlyNodeUsesTextKind() {
        val root = UiNode(null, null, "root", false, false, Bounds(0, 0, 1, 1),
            listOf(leaf("Delivering to Home", null, false, false)))
        val s = TreeSerializer.serialize(UiSnapshot("com.x", root))
        assertTrue(s.text.contains("#0 [text] \"Delivering to Home\""))
    }
}
