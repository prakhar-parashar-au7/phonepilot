package com.phonepilot.core.device

import com.phonepilot.core.model.ActionResult
import com.phonepilot.core.model.AgentAction
import com.phonepilot.core.model.UiSnapshot
import com.phonepilot.core.agent.UiActionSession

interface DeviceController {
    suspend fun snapshot(): UiSnapshot
    fun captureActionSession(snapshot: UiSnapshot): UiActionSession = UiActionSession.capture(snapshot)
    suspend fun execute(action: AgentAction): ActionResult = execute(action, null)
    suspend fun execute(action: AgentAction, session: UiActionSession?): ActionResult
}
