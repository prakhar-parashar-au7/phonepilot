package com.phonepilot.app

import android.Manifest
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.content.pm.PackageManager
import android.provider.Settings
import android.view.accessibility.AccessibilityManager

data class SetupState(
    val accessibilityEnabled: Boolean,
    val canDrawOverlays: Boolean,
    val microphoneGranted: Boolean,
    val notificationsGranted: Boolean,
) {
    val ready: Boolean
        get() = accessibilityEnabled && canDrawOverlays && microphoneGranted && notificationsGranted
}

class SetupStateReader(private val context: Context) {
    fun read(): SetupState = SetupState(
        accessibilityEnabled = isAccessibilityEnabled(),
        canDrawOverlays = Settings.canDrawOverlays(context),
        microphoneGranted = isGranted(Manifest.permission.RECORD_AUDIO),
        notificationsGranted = isGranted(Manifest.permission.POST_NOTIFICATIONS),
    )

    private fun isGranted(permission: String) =
        context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun isAccessibilityEnabled(): Boolean {
        val manager = context.getSystemService(AccessibilityManager::class.java) ?: return false
        return manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
            .any { it.resolveInfo.serviceInfo.packageName == context.packageName }
    }
}
