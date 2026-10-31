package com.phonepilot.core.perception

import com.phonepilot.core.model.UiNode
import com.phonepilot.core.model.UiSnapshot

data class SerializedTree(val text: String, val index: Map<Int, UiNode>)

object TreeSerializer {
    fun serialize(snapshot: UiSnapshot): SerializedTree {
        val lines = StringBuilder()
        val index = LinkedHashMap<Int, UiNode>()
        var next = 0
        fun visit(node: UiNode) {
            val interesting = node.clickable || node.editable || node.label != null
            if (interesting) {
                val idx = next++
                index[idx] = node
                val kind = when {
                    node.editable -> "type"
                    node.clickable -> "tap"
                    else -> "text"
                }
                val label = node.label ?: ""
                lines.append("#$idx [$kind] \"$label\" (${node.bounds.centerX},${node.bounds.centerY})\n")
            }
            node.children.forEach(::visit)
        }
        visit(snapshot.root)
        return SerializedTree(lines.toString().trimEnd(), index)
    }
}
