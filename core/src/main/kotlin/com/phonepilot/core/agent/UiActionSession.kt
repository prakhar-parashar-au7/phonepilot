package com.phonepilot.core.agent

import com.phonepilot.core.model.Bounds
import com.phonepilot.core.model.UiNode
import com.phonepilot.core.model.UiSnapshot
import com.phonepilot.core.perception.TreeSerializer
import java.security.MessageDigest

data class UiElementFingerprint(
    val packageName: String,
    val role: String,
    val bounds: Bounds,
    val clickable: Boolean,
    val editable: Boolean,
    val labelHash: String?,
)

data class UiActionSession(private val elements: Map<Int, UiElementFingerprint>) {
    fun matches(index: Int, fresh: UiSnapshot): Boolean = elements[index] == capture(fresh).elements[index]

    companion object {
        fun capture(snapshot: UiSnapshot): UiActionSession = UiActionSession(
            TreeSerializer.serialize(snapshot).index.mapValues { (_, node) -> fingerprint(snapshot.foregroundPackage, node) },
        )

        private fun fingerprint(packageName: String, node: UiNode) = UiElementFingerprint(
            packageName = packageName,
            role = when { node.editable -> "editable"; node.clickable -> "clickable"; else -> "text" },
            bounds = node.bounds,
            clickable = node.clickable,
            editable = node.editable,
            labelHash = node.label?.let(::sha256),
        )

        private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray())
            .joinToString("") { "%02x".format(it) }
    }
}
