package com.phonepilot.app

import com.phonepilot.core.model.AgentAction
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class VoiceCommandTest {
    @Test fun mapsAllowedOpenCommandToPackage() {
        assertEquals("com.whatsapp", VoiceCommand.openPackage("Open WhatsApp"))
        assertNull(VoiceCommand.openPackage("send a message"))
    }

    @Test fun recognizedOpenCommandProducesLocalActionWithoutTheLlm() {
        assertEquals(
            AgentAction.OpenApp("com.grofers.customerapp"),
            VoiceCommand.localAction("Open Blinkit"),
        )
    }

    @Test fun speechRecognitionAliasForBlinkitProducesLocalAction() {
        assertEquals(
            AgentAction.OpenApp("com.grofers.customerapp"),
            VoiceCommand.localAction("Open blinked"),
        )
    }

    @Test fun compoundBlinkitTaskIsLeftForThePlanner() {
        assertNull(VoiceCommand.localAction("Open Blinkit, search for potatoes and add potatoes to my cart"))
    }
}
