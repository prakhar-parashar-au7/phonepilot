package com.phonepilot.app

import com.phonepilot.core.model.ActionResult
import com.phonepilot.core.model.AgentAction
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals

class NodeActionMapperTest {
    @Test fun nullServiceFailsWithoutAction() = runBlocking {
        val controller = AccessibilityDeviceController(serviceProvider = { null })

        assertEquals(
            ActionResult(false, "Accessibility service is not active"),
            controller.execute(AgentAction.PressBack),
        )
    }
}
