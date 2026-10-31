package com.phonepilot.app

import android.app.Service
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.graphics.Color
import android.os.IBinder
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import com.phonepilot.core.model.AgentAction
import com.phonepilot.core.model.ActionResult
import com.phonepilot.core.agent.ActionPolicy
import com.phonepilot.core.agent.AgentEvent
import com.phonepilot.core.agent.UiActionSession
import com.phonepilot.core.agent.Orchestrator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class OverlayService : Service() {
    private var bubble: Button? = null
    private var status: TextView? = null
    private var confirmation: LinearLayout? = null
    private lateinit var voice: VoiceController
    private val mainHandler = Handler(Looper.getMainLooper())
    private var overlayState: OverlayState = OverlayState.Idle
    private val actionAudit = ActionAuditTrail()
    private var lastSuggestedAction: Pair<AgentAction, String>? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!::voice.isInitialized) voice = VoiceController(this)
        startForeground(7, notification())
        if (bubble == null) showBubble()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        if (::voice.isInitialized) voice.close()
        mainHandler.removeCallbacksAndMessages(null)
        bubble?.let { (getSystemService(WINDOW_SERVICE) as WindowManager).removeView(it) }
        status?.let { (getSystemService(WINDOW_SERVICE) as WindowManager).removeView(it) }
        confirmation?.let { (getSystemService(WINDOW_SERVICE) as WindowManager).removeView(it) }
        super.onDestroy()
    }

    private fun showBubble() {
        val manager = getSystemService(WINDOW_SERVICE) as WindowManager
        bubble = Button(this).apply {
            text = "🎙"
            setOnClickListener {
                showStatus("Listening…")
                voice.listen(::handleTranscript, ::showStatus)
            }
        }
        manager.addView(bubble, params(96, 96, Gravity.END or Gravity.CENTER_VERTICAL))
    }

    private fun showStatus(message: String) {
        val manager = getSystemService(WINDOW_SERVICE) as WindowManager
        overlayState = OverlayState.Working(message, SystemClock.elapsedRealtime())
        status?.let {
            mainHandler.removeCallbacksAndMessages(it)
            manager.removeView(it)
        }
        status = TextView(this).apply { text = message; setTextColor(Color.WHITE); setBackgroundColor(Color.DKGRAY); setPadding(28, 20, 28, 20) }
        manager.addView(status, params(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        mainHandler.removeCallbacksAndMessages(status)
        mainHandler.postAtTime({
            if (overlayState.at(SystemClock.elapsedRealtime()) == OverlayState.Idle) {
                status?.let { manager.removeView(it) }
                status = null
            }
        }, status, SystemClock.uptimeMillis() + OverlayState.DEFAULT_TIMEOUT_MILLIS)
    }

    private fun showConfirmation(
        action: AgentAction,
        question: String,
        consequence: String,
        session: UiActionSession,
        packageName: String,
    ) {
        val manager = getSystemService(WINDOW_SERVICE) as WindowManager
        confirmation?.let { manager.removeView(it) }
        confirmation = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.DKGRAY)
            setPadding(28, 20, 28, 20)
            addView(TextView(this@OverlayService).apply { text = "$question\n$consequence"; setTextColor(Color.WHITE) })
            addView(Button(this@OverlayService).apply {
                text = "Confirm"
                setOnClickListener {
                    confirmation?.let { manager.removeView(it) }
                    confirmation = null
                    CoroutineScope(Dispatchers.Main).launch {
                        val result = AccessibilityDeviceController({ PhonePilotAccessibilityService.active }, VoiceCommand.allowedPackages()).execute(action, session)
                        recordActionResult(action, packageName, result)
                        showStatus(result.message)
                    }
                }
            })
            addView(Button(this@OverlayService).apply { text = "Cancel"; setOnClickListener { confirmation?.let { manager.removeView(it) }; confirmation = null; showStatus("Cancelled") } })
        }
        manager.addView(confirmation, params(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
    }

    private fun handleTranscript(transcript: String) {
        val localAction = VoiceCommand.localAction(transcript)
        if (localAction != null) {
            showStatus("Opening ${transcript.removePrefix("open ")}…")
            CoroutineScope(Dispatchers.Main).launch {
                val result = AccessibilityDeviceController({ PhonePilotAccessibilityService.active }, VoiceCommand.allowedPackages())
                    .execute(localAction)
                showStatus(if (result.success) "Opened ${transcript.removePrefix("open ")}" else result.message)
            }
            return
        }
        val backend = SecureBackendConfigStore(this).load()
        if (backend != null) {
            showStatus("Thinking…")
            CoroutineScope(Dispatchers.Main).launch {
                val device = AccessibilityDeviceController({ PhonePilotAccessibilityService.active }, VoiceCommand.allowedPackages())
                Orchestrator(device, WorkerLlmClient(backend), ActionPolicy(VoiceCommand.allowedPackages())).run(transcript) { event ->
                    when (event) {
                        is AgentEvent.Acting -> {
                            lastSuggestedAction = event.action to event.packageName
                            recordAction(event.action, event.packageName, "recommended", "ok")
                            showStatus("Working: ${event.action}")
                        }
                        is AgentEvent.ConfirmationRequired -> {
                            recordAction(event.action, event.packageName, "confirmation_required", "consequential_action")
                            showConfirmation(event.action, event.question, event.consequence, event.session, event.packageName)
                        }
                        is AgentEvent.Failed -> {
                            actionAudit.record("worker", "unknown", null, "failed", "worker_failure")
                            showStatus("PhonePilot: ${event.message}")
                        }
                        is AgentEvent.Finished -> if (event.outcome != com.phonepilot.core.agent.Outcome.ERROR) showStatus("PhonePilot: ${event.outcome}")
                        is AgentEvent.Executed -> lastSuggestedAction?.let { (action, packageName) ->
                            recordActionResult(action, packageName, event.result)
                        }
                    }
                }
            }
            return
        }
        showStatus("Heard: $transcript\nLLM agent is next")
    }

    private fun params(width: Int, height: Int, gravity: Int) = WindowManager.LayoutParams(width, height,
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
        android.graphics.PixelFormat.TRANSLUCENT).apply { this.gravity = gravity }

    private fun recordAction(action: AgentAction, packageName: String, outcome: String, reasonCode: String) {
        actionAudit.record(action.auditKind(), packageName, action.auditIndex(), outcome, reasonCode)
    }

    private fun recordActionResult(action: AgentAction, packageName: String, result: ActionResult) {
        val reasonCode = when {
            result.success -> "ok"
            result.message.contains("stale UI", ignoreCase = true) -> "stale_ui"
            result.message.contains("not allowed", ignoreCase = true) -> "policy_rejected"
            result.message.contains("not active", ignoreCase = true) -> "service_unavailable"
            else -> "execution_failed"
        }
        recordAction(action, packageName, if (result.success) "executed" else "rejected", reasonCode)
    }

    private fun AgentAction.auditKind(): String = when (this) {
        is AgentAction.OpenApp -> "open_app"
        is AgentAction.TapElement -> "tap_element"
        is AgentAction.TypeText -> "type_text"
        is AgentAction.Scroll -> "scroll"
        AgentAction.PressBack -> "press_back"
        AgentAction.PressHome -> "press_home"
        is AgentAction.Wait -> "wait"
        is AgentAction.AskUser -> "ask_user"
        is AgentAction.TaskComplete -> "task_complete"
    }

    private fun AgentAction.auditIndex(): Int? = when (this) {
        is AgentAction.TapElement -> index
        is AgentAction.TypeText -> index
        else -> null
    }

    private fun notification(): android.app.Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("phonepilot", "PhonePilot", NotificationManager.IMPORTANCE_LOW))
        return android.app.Notification.Builder(this, "phonepilot").setSmallIcon(android.R.drawable.ic_btn_speak_now).setContentTitle("PhonePilot is ready").build()
    }
}
