package com.phonepilot.app

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

object VoiceTranscript {
    fun firstUsable(results: List<String>): String? = results.firstOrNull { it.isNotBlank() }?.trim()
}

class VoiceController(private val context: Context) {
    private var recognizer: SpeechRecognizer? = null

    fun listen(onTranscript: (String) -> Unit, onError: (String) -> Unit) {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) return onError("Speech recognition is unavailable")
        recognizer?.destroy()
        recognizer = SpeechRecognizer.createSpeechRecognizer(context).apply {
            setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) = Unit
                override fun onBeginningOfSpeech() = Unit
                override fun onRmsChanged(rmsdB: Float) = Unit
                override fun onBufferReceived(buffer: ByteArray?) = Unit
                override fun onEndOfSpeech() = Unit
                override fun onPartialResults(partialResults: Bundle?) = Unit
                override fun onEvent(eventType: Int, params: Bundle?) = Unit
                override fun onError(error: Int) = onError("Speech recognition error ($error)")
                override fun onResults(results: Bundle?) {
                    VoiceTranscript.firstUsable(results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty())
                        ?.let(onTranscript) ?: onError("No speech was recognized")
                }
            })
            startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            })
        }
    }

    fun close() { recognizer?.destroy(); recognizer = null }
}
