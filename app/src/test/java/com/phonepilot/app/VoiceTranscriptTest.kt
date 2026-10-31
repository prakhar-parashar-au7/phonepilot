package com.phonepilot.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class VoiceTranscriptTest {
    @Test fun picksFirstNonblankRecognitionResult() {
        assertEquals("open WhatsApp", VoiceTranscript.firstUsable(listOf(" ", "open WhatsApp")))
        assertNull(VoiceTranscript.firstUsable(listOf(" ", "")))
    }
}
