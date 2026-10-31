package com.phonepilot.core.agent

import com.phonepilot.core.device.DeviceController
import com.phonepilot.core.llm.LlmClient
import com.phonepilot.core.llm.LlmContext
import com.phonepilot.core.llm.Step
import com.phonepilot.core.model.ActionResult
import com.phonepilot.core.model.AgentAction
import com.phonepilot.core.perception.TreeSerializer

enum class Outcome { COMPLETED, ASKED_USER, CONFIRMATION_REQUIRED, STEP_CAP, ERROR }

sealed interface AgentEvent {
    data class Acting(val step: Int, val action: AgentAction, val packageName: String) : AgentEvent
    data class Executed(val result: ActionResult) : AgentEvent
    data class ConfirmationRequired(
        val action: AgentAction,
        val question: String,
        val consequence: String,
        val session: UiActionSession,
        val packageName: String,
    ) : AgentEvent
    data class Failed(val message: String) : AgentEvent
    data class Finished(val outcome: Outcome) : AgentEvent
}

class Orchestrator(
    private val device: DeviceController,
    private val llm: LlmClient,
    private val policy: ActionPolicy = ActionPolicy(),
    private val maxSteps: Int = 25,
) {
    suspend fun run(task: String, onEvent: (AgentEvent) -> Unit = {}): Outcome {
        val history = mutableListOf<Step>()
        val taskIntent = TaskIntent.from(task)
        val outcome = try {
            loop(task, taskIntent, history, onEvent)
        } catch (e: Exception) {
            val message = (e.message ?: "PhonePilot Worker failed").lineSequence().first().take(160)
            onEvent(AgentEvent.Failed(message))
            Outcome.ERROR
        }
        onEvent(AgentEvent.Finished(outcome))
        return outcome
    }

    private suspend fun loop(
        task: String,
        taskIntent: TaskIntent,
        history: MutableList<Step>,
        onEvent: (AgentEvent) -> Unit,
    ): Outcome {
        for (step in 1..maxSteps) {
            val snapshot = device.snapshot()
            val session = device.captureActionSession(snapshot)
            val tree = TreeSerializer.serialize(snapshot)
            val context = LlmContext(task, snapshot.foregroundPackage, tree.text, history.toList())
            val action = llm.nextAction(context)
            onEvent(AgentEvent.Acting(step, action, snapshot.foregroundPackage))
            when (action) {
                is AgentAction.TaskComplete -> return Outcome.COMPLETED
                is AgentAction.AskUser -> return Outcome.ASKED_USER
                else -> {
                    when (val decision = policy.decide(action, snapshot, taskIntent)) {
                        PolicyDecision.Execute -> Unit
                        is PolicyDecision.Reject -> {
                            onEvent(AgentEvent.Executed(ActionResult(false, decision.reason)))
                            history += Step(renderAction(action), decision.reason)
                            continue
                        }
                        is PolicyDecision.Confirm -> {
                            onEvent(AgentEvent.ConfirmationRequired(action, decision.question, decision.consequence, session, snapshot.foregroundPackage))
                            return Outcome.CONFIRMATION_REQUIRED
                        }
                    }
                    val result = device.execute(action, session)
                    onEvent(AgentEvent.Executed(result))
                    history += Step(renderAction(action), result.message)
                }
            }
        }
        return Outcome.STEP_CAP
    }

    private fun renderAction(a: AgentAction): String = when (a) {
        is AgentAction.OpenApp -> "open ${a.pkg}"
        is AgentAction.TapElement -> "tap #${a.index}"
        is AgentAction.TypeText -> "type \"${a.text}\" into #${a.index}"
        is AgentAction.Scroll -> "scroll ${a.direction}"
        AgentAction.PressBack -> "back"
        AgentAction.PressHome -> "home"
        is AgentAction.Wait -> "wait ${a.millis}ms"
        is AgentAction.AskUser -> "ask"
        is AgentAction.TaskComplete -> "done"
    }
}
