package com.phonepilot.core.llm

import com.phonepilot.core.model.AgentAction
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class LlmTransportException(message: String) : Exception(message)

class OpenAiCompatibleLlmClient(
    private val baseUrl: String,
    private val apiKey: String,
    private val model: String,
    private val http: OkHttpClient = OkHttpClient(),
    private val maxParseRetries: Int = 2,
) : LlmClient {
    private val json = Json { ignoreUnknownKeys = true }
    private val mediaType = "application/json".toMediaType()

    override suspend fun nextAction(context: LlmContext): AgentAction {
        val messages = PromptBuilder.build(context).toMutableList()
        var lastError: String? = null
        repeat(maxParseRetries + 1) {
            val content = call(messages)
            try {
                return ActionJson.parse(content)
            } catch (e: ActionParseException) {
                lastError = e.message
                messages += ChatMessage("assistant", content)
                messages += ChatMessage("user",
                    "That was not valid. ${e.message}. Reply with exactly one JSON action object and nothing else.")
            }
        }
        throw LlmTransportException("LLM did not return a valid action: $lastError")
    }

    private suspend fun call(messages: List<ChatMessage>): String = withContext(Dispatchers.IO) {
        val payload = buildJsonObject {
            put("model", model)
            put("temperature", 0)
            putJsonArray("messages") {
                messages.forEach {
                    addJsonObject { put("role", it.role); put("content", it.content) }
                }
            }
        }
        val req = Request.Builder()
            .url("$baseUrl/chat/completions")
            .header("Authorization", "Bearer $apiKey")
            .post(payload.toString().toRequestBody(mediaType))
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw LlmTransportException("HTTP ${resp.code}: $text")
            json.parseToJsonElement(text).jsonObject["choices"]
                ?.jsonArray?.getOrNull(0)?.jsonObject
                ?.get("message")?.jsonObject?.get("content")?.jsonPrimitive?.contentOrNull
                ?: throw LlmTransportException("no content in response: $text")
        }
    }
}
