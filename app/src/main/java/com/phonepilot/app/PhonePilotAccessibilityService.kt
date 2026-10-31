package com.phonepilot.app

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

class PhonePilotAccessibilityService : AccessibilityService() {
    override fun onServiceConnected() { active = this }
    override fun onDestroy() { if (active === this) active = null; super.onDestroy() }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit
    override fun onInterrupt() = Unit

    fun currentRoot(): AccessibilityNodeInfo? = rootInActiveWindow

    fun foregroundPackage(): String? = rootInActiveWindow?.packageName?.toString()

    companion object { @Volatile var active: PhonePilotAccessibilityService? = null }
}
