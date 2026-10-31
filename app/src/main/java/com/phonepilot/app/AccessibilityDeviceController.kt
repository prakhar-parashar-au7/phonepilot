package com.phonepilot.app

import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import com.phonepilot.core.device.DeviceController
import com.phonepilot.core.agent.UiActionSession
import com.phonepilot.core.model.ActionResult
import com.phonepilot.core.model.AgentAction
import com.phonepilot.core.model.Bounds
import com.phonepilot.core.model.ScrollDirection
import com.phonepilot.core.model.UiNode
import com.phonepilot.core.model.UiSnapshot
import com.phonepilot.core.perception.TreeSerializer

class DeviceUnavailableException(message: String) : IllegalStateException(message)

class AccessibilityDeviceController(
    private val serviceProvider: () -> PhonePilotAccessibilityService?,
    private val allowedPackages: Set<String> = emptySet(),
) : DeviceController {
    override suspend fun snapshot(): UiSnapshot {
        val service = serviceProvider() ?: throw DeviceUnavailableException("Accessibility service is not active")
        val root = service.currentRoot() ?: throw DeviceUnavailableException("No accessible UI is available")
        return root.toSnapshot()
    }

    override suspend fun execute(action: AgentAction, session: UiActionSession?): ActionResult {
        val service = serviceProvider() ?: return ActionResult(false, "Accessibility service is not active")
        if ((action is AgentAction.TapElement || action is AgentAction.TypeText) &&
            (session == null || !session.matches(if (action is AgentAction.TapElement) action.index else (action as AgentAction.TypeText).index, snapshot()))) {
            return ActionResult(false, "stale UI action discarded")
        }
        if (action is AgentAction.TypeText) {
            val node = TreeSerializer.serialize(snapshot()).index[action.index]
                ?: return ActionResult(false, "stale UI action discarded")
            if (!LocalActionSafety.canType(node)) return ActionResult(false, "typing into this field is not allowed")
        }
        return when (action) {
            is AgentAction.OpenApp -> openApp(service, action.pkg)
            is AgentAction.TapElement -> withNode(service, action.index) { it.performAction(AccessibilityNodeInfo.ACTION_CLICK) }
            is AgentAction.TypeText -> withNode(service, action.index) { node ->
                node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
                    putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, action.text)
                })
            }
            is AgentAction.Scroll -> withNode(service, 0, action.direction)
            AgentAction.PressBack -> global(service, android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK, "back")
            AgentAction.PressHome -> global(service, android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME, "home")
            is AgentAction.Wait -> ActionResult(true, "waited ${action.millis}ms")
            is AgentAction.AskUser, is AgentAction.TaskComplete -> ActionResult(false, "action is not executable")
        }
    }

    private fun openApp(service: PhonePilotAccessibilityService, pkg: String): ActionResult {
        if (allowedPackages.isNotEmpty() && pkg !in allowedPackages) return ActionResult(false, "app is not allowed: $pkg")
        val intent = service.packageManager.getLaunchIntentForPackage(pkg)
            ?: return ActionResult(false, "app is not installed: $pkg")
        service.startActivity(intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
        return ActionResult(true, "opened $pkg")
    }

    private fun withNode(service: PhonePilotAccessibilityService, index: Int, perform: (AccessibilityNodeInfo) -> Boolean): ActionResult {
        val root = service.currentRoot() ?: return ActionResult(false, "No accessible UI is available")
        val nodes = mutableListOf<AccessibilityNodeInfo>()
        collect(root, nodes)
        val node = nodes.getOrNull(index)
        if (node == null) {
            nodes.drop(1).forEach { it.recycle() }
            return ActionResult(false, "element #$index is not in current snapshot")
        }
        val success = perform(node)
        nodes.drop(1).forEach { it.recycle() }
        return ActionResult(success, if (success) "executed element #$index" else "action failed for element #$index")
    }

    private fun withNode(service: PhonePilotAccessibilityService, index: Int, direction: ScrollDirection): ActionResult {
        val action = if (direction == ScrollDirection.UP) AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD else AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
        return withNode(service, index) { it.performAction(action) }
    }

    private fun global(service: PhonePilotAccessibilityService, action: Int, label: String): ActionResult {
        val success = service.performGlobalAction(action)
        return ActionResult(success, if (success) "pressed $label" else "could not press $label")
    }

    private fun collect(node: AccessibilityNodeInfo, out: MutableList<AccessibilityNodeInfo>) {
        val interesting = node.isClickable || node.isEditable || !node.text.isNullOrBlank() || !node.contentDescription.isNullOrBlank()
        if (interesting) out += node
        for (i in 0 until node.childCount) node.getChild(i)?.let { child -> collect(child, out) }
    }

    private fun AccessibilityNodeInfo.toSnapshot(): UiSnapshot {
        val pkg = packageName?.toString() ?: throw DeviceUnavailableException("Foreground package is unavailable")
        return UiSnapshot(pkg, toUiNode())
    }

    private fun AccessibilityNodeInfo.toUiNode(): UiNode {
        val rect = android.graphics.Rect().also(::getBoundsInScreen)
        val children = buildList {
            for (i in 0 until childCount) getChild(i)?.let { child ->
                try { add(child.toUiNode()) } finally { child.recycle() }
            }
        }
        return UiNode(text?.toString(), contentDescription?.toString(), className?.toString(), isClickable, isEditable,
            Bounds(rect.left, rect.top, rect.right, rect.bottom), children)
    }
}
