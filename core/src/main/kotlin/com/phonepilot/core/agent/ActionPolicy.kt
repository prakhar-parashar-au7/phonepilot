package com.phonepilot.core.agent

import com.phonepilot.core.model.AgentAction
import com.phonepilot.core.model.UiSnapshot
import com.phonepilot.core.perception.TreeSerializer

sealed interface PolicyDecision {
    data object Execute : PolicyDecision
    data class Confirm(
        val action: AgentAction,
        val question: String,
        val consequence: String,
    ) : PolicyDecision
    data class Reject(val reason: String) : PolicyDecision
}

class ActionPolicy(private val allowedPackages: Set<String>? = null) {
    fun decide(
        action: AgentAction,
        snapshot: UiSnapshot,
        taskIntent: TaskIntent = TaskIntent(),
    ): PolicyDecision = when (action) {
        is AgentAction.OpenApp -> if (allowedPackages == null || action.pkg in allowedPackages) {
            PolicyDecision.Execute
        } else {
            PolicyDecision.Reject("app is not allowed: ${action.pkg}")
        }
        is AgentAction.TapElement -> indexedDecision(action, action.index, snapshot, taskIntent)
        is AgentAction.TypeText -> indexedDecision(action, action.index, snapshot, taskIntent)
        else -> PolicyDecision.Execute
    }

    private fun indexedDecision(
        action: AgentAction,
        index: Int,
        snapshot: UiSnapshot,
        taskIntent: TaskIntent,
    ): PolicyDecision {
        val serialized = TreeSerializer.serialize(snapshot)
        val node = serialized.index[index]
            ?: return PolicyDecision.Reject("element #$index is not in current snapshot")
        val label = node.label.orEmpty().lowercase()
        val consequence = consequentialLabels.firstOrNull { label.contains(it) }
            ?: return PolicyDecision.Execute
        if (consequence == "send" && taskIntent.matchesVisibleRecipient(serialized.index.values.map { it.label })) {
            return PolicyDecision.Execute
        }
        return PolicyDecision.Confirm(
            action = action,
            question = "Confirm ${node.label}",
            consequence = "This may $consequence in ${snapshot.foregroundPackage}",
        )
    }

    private companion object {
        val consequentialLabels = listOf(
            "place order", "send", "pay", "buy", "call", "delete", "share", "allow",
        )
    }
}
