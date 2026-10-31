package com.phonepilot.core.model

data class Bounds(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    val centerX: Int get() = (left + right) / 2
    val centerY: Int get() = (top + bottom) / 2
}

data class UiNode(
    val text: String?,
    val contentDesc: String?,
    val className: String?,
    val clickable: Boolean,
    val editable: Boolean,
    val bounds: Bounds,
    val children: List<UiNode>,
) {
    val label: String?
        get() = (text?.takeIf { it.isNotBlank() } ?: contentDesc?.takeIf { it.isNotBlank() })?.trim()
}

data class UiSnapshot(val foregroundPackage: String, val root: UiNode)
