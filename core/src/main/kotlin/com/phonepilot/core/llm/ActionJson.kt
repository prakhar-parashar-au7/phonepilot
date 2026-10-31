package com.phonepilot.core.llm

import com.phonepilot.core.model.AgentAction
import com.phonepilot.core.model.ScrollDirection
import kotlinx.serialization.json.*

class ActionParseException(message: String) : Exception(message)

object ActionJson {
    private val json = Json { ignoreUnknownKeys = true }

    fun parse(raw: String): AgentAction {
        val start = raw.indexOf('{')
        val end = raw.lastIndexOf('}')
        if (start < 0 || end <= start) throw ActionParseException("no JSON object in: $raw")
        val obj = try {
            json.parseToJsonElement(raw.substring(start, end + 1)).jsonObject
        } catch (e: Exception) {
            throw ActionParseException("invalid JSON: ${e.message}")
        }
        fun str(k: String) = obj[k]?.jsonPrimitive?.contentOrNull
            ?: throw ActionParseException("missing '$k'")
        fun int(k: String) = obj[k]?.jsonPrimitive?.intOrNull
            ?: throw ActionParseException("missing int '$k'")
        return when (val a = str("action")) {
            "open" -> AgentAction.OpenApp(str("pkg"))
            "tap" -> AgentAction.TapElement(int("index"))
            "type" -> AgentAction.TypeText(int("index"), str("text"))
            "scroll" -> AgentAction.Scroll(
                if (str("direction").equals("up", true)) ScrollDirection.UP else ScrollDirection.DOWN
            )
            "back" -> AgentAction.PressBack
            "home" -> AgentAction.PressHome
            "wait" -> AgentAction.Wait(obj["millis"]?.jsonPrimitive?.longOrNull ?: 1000L)
            "ask" -> AgentAction.AskUser(str("question"), str("consequence"))
            "done" -> AgentAction.TaskComplete(str("summary"))
            else -> throw ActionParseException("unknown action '$a'")
        }
    }

    fun schemaDoc(): String = """
        Reply with EXACTLY ONE JSON object, no prose. One of:
        {"action":"open","pkg":"<package>"}
        {"action":"tap","index":<int>}
        {"action":"type","index":<int>,"text":"<text>"}
        {"action":"scroll","direction":"up|down"}
        {"action":"back"}
        {"action":"home"}
        {"action":"wait","millis":<int>}
        {"action":"ask","question":"<text>","consequence":"<text>"}
        {"action":"done","summary":"<text>"}
    """.trimIndent()
}
