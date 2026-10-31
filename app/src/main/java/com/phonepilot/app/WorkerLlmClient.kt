package com.phonepilot.app

import com.phonepilot.core.llm.LlmClient
import com.phonepilot.core.llm.LlmContext
import com.phonepilot.core.llm.LlmTransportException
import com.phonepilot.core.model.AgentAction
import com.phonepilot.core.model.ScrollDirection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

object WorkerFailure {
    fun message(statusCode: Int, body: String): String {
        val code = Regex("\\\"code\\\"\\s*:\\s*\\\"([a-z_]+)\\\"").find(body)?.groupValues?.getOrNull(1)
        return when (code) {
            "provider_auth_failed" -> "OpenAI API key was rejected"
            "provider_schema_rejected" -> "OpenAI rejected the PhonePilot action schema"
            "provider_request_rejected" -> "OpenAI rejected the PhonePilot request"
            "provider_unavailable" -> "OpenAI API is unavailable or out of quota"
            "provider_timeout" -> "OpenAI API timed out"
            "unauthorized" -> "PhonePilot device token was rejected"
            "rate_limited", "daily_limit" -> "PhonePilot request limit reached"
            else -> "PhonePilot Worker returned HTTP $statusCode"
        }
    }
}

class WorkerLlmClient(private val config: BackendConfig) : LlmClient {
    override suspend fun nextAction(context: LlmContext): AgentAction = withContext(Dispatchers.IO) {
        val history = context.history.joinToString("\n") { "${it.action} ${it.resultMessage}" }
        if (SensitiveContentPolicy.safeOrNull(context.task, context.serializedTree, history) == null) {
            throw LlmTransportException("Sensitive information was detected and was not sent to the AI service")
        }
        val payload = JSONObject().apply {
            put("task", context.task); put("activePackage", context.foregroundPackage); put("serializedUiTree", context.serializedTree)
            put("history", JSONArray().apply { context.history.forEach { put(JSONObject().put("action", it.action).put("result", it.resultMessage).put("success", true)) } })
        }
        val connection = (URL(config.workerUrl + "/v1/next-action").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"; connectTimeout = 15_000; readTimeout = 20_000; doOutput = true
            setRequestProperty("Content-Type", "application/json"); setRequestProperty("Authorization", "Bearer ${config.deviceToken}")
        }
        connection.outputStream.use { it.write(payload.toString().toByteArray()) }
        val body = (if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream).bufferedReader().use { it.readText() }
        if (connection.responseCode !in 200..299) throw LlmTransportException(WorkerFailure.message(connection.responseCode, body))
        parse(JSONObject(body).getJSONObject("action"))
    }

    private fun parse(a: JSONObject): AgentAction = when (a.getString("type")) {
        "open_app" -> AgentAction.OpenApp(a.getString("packageName"))
        "tap_element" -> AgentAction.TapElement(a.getInt("index"))
        "type_text" -> AgentAction.TypeText(a.getInt("index"), a.getString("text"))
        "scroll" -> AgentAction.Scroll(if (a.getString("direction") == "up") ScrollDirection.UP else ScrollDirection.DOWN)
        "press_back" -> AgentAction.PressBack
        "press_home" -> AgentAction.PressHome
        "wait" -> AgentAction.Wait(a.getLong("milliseconds"))
        "ask_user" -> AgentAction.AskUser(a.getString("question"), a.getString("consequence"))
        "task_complete" -> AgentAction.TaskComplete(a.getString("summary"))
        else -> throw LlmTransportException("PhonePilot Worker returned an invalid action")
    }
}
