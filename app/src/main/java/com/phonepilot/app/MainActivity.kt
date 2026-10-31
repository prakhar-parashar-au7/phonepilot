package com.phonepilot.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

class MainActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var workerUrl: EditText
    private lateinit var deviceToken: EditText

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        status = TextView(this).apply { textSize = 18f }
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 80, 48, 48)
            addView(TextView(this@MainActivity).apply { text = "PhonePilot setup"; textSize = 24f })
            addView(status)
            addView(button("Accessibility settings") { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) })
            addView(button("Overlay settings") {
                startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
            })
            addView(button("Grant microphone") { requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), 100) })
            addView(button("Grant notifications") { requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 101) })
            workerUrl = EditText(this@MainActivity).apply { hint = "Worker URL (https://…workers.dev)" }
            deviceToken = EditText(this@MainActivity).apply { hint = "Device token" }
            addView(workerUrl)
            addView(deviceToken)
            addView(button("Save secure Worker configuration") {
                val config = BackendConfig(workerUrl.text.toString(), deviceToken.text.toString())
                if (config.isValid) { SecureBackendConfigStore(this@MainActivity).save(config); deviceToken.setText(""); refresh() }
                else status.text = "Worker URL must be HTTPS and device token cannot be blank"
            })
            addView(button("Start floating bubble") { startForegroundService(Intent(this@MainActivity, OverlayService::class.java)) })
        }
        setContentView(layout)
    }

    override fun onResume() { super.onResume(); refresh() }

    private fun refresh() {
        val state = SetupStateReader(this).read()
        SecureBackendConfigStore(this).load()?.let { workerUrl.setText(it.workerUrl) }
        val backendReady = SecureBackendConfigStore(this).load() != null
        status.text = "Accessibility: ${state.accessibilityEnabled}\nOverlay: ${state.canDrawOverlays}\nMicrophone: ${state.microphoneGranted}\nNotifications: ${state.notificationsGranted}\nWorker: $backendReady\n\nReady: ${state.ready && backendReady}"
    }

    private fun button(label: String, action: () -> Unit) = Button(this).apply {
        text = label
        setOnClickListener { action() }
    }
}
