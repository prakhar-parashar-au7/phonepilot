package com.phonepilot.core.testutil

import com.phonepilot.core.device.DeviceController
import com.phonepilot.core.model.ActionResult
import com.phonepilot.core.model.AgentAction
import com.phonepilot.core.model.UiSnapshot
import com.phonepilot.core.agent.UiActionSession

class FakeDeviceController(
    private val snapshots: List<UiSnapshot>,
    private val failures: Map<AgentAction, String> = emptyMap(),
) : DeviceController {
    val executed = mutableListOf<AgentAction>()
    val executedSessions = mutableListOf<UiActionSession?>()
    private var i = 0

    override suspend fun snapshot(): UiSnapshot {
        val s = snapshots[i.coerceAtMost(snapshots.lastIndex)]
        i++
        return s
    }

    override suspend fun execute(action: AgentAction, session: UiActionSession?): ActionResult {
        executed += action
        executedSessions += session
        failures[action]?.let { return ActionResult(false, it) }
        return ActionResult(true, "ok")
    }
}
