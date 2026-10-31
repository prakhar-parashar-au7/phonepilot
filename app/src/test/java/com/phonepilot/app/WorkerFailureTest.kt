package com.phonepilot.app

import kotlin.test.Test
import kotlin.test.assertEquals

class WorkerFailureTest {
    @Test fun mapsProviderRateLimitToSafeBillingGuidance() {
        assertEquals(
            "OpenAI API is unavailable or out of quota",
            WorkerFailure.message(503, "{\"error\":{\"code\":\"provider_unavailable\"}}"),
        )
    }

    @Test fun mapsRejectedProviderCredentialsWithoutExposingProviderDetails() {
        assertEquals(
            "OpenAI API key was rejected",
            WorkerFailure.message(502, "{\"error\":{\"code\":\"provider_auth_failed\",\"message\":\"Provider credentials rejected\"}}"),
        )
    }

    @Test fun mapsRejectedProviderRequestWithoutExposingProviderDetails() {
        assertEquals(
            "OpenAI rejected the PhonePilot request",
            WorkerFailure.message(502, "{\"error\":{\"code\":\"provider_request_rejected\",\"message\":\"Provider request rejected\"}}"),
        )
    }

    @Test fun mapsRejectedProviderSchemaWithoutExposingProviderDetails() {
        assertEquals(
            "OpenAI rejected the PhonePilot action schema",
            WorkerFailure.message(502, "{\"error\":{\"code\":\"provider_schema_rejected\",\"message\":\"Provider action schema rejected\"}}"),
        )
    }

    @Test fun doesNotExposeUnexpectedWorkerErrorBody() {
        assertEquals(
            "PhonePilot Worker returned HTTP 502",
            WorkerFailure.message(502, "{\"error\":{\"message\":\"secret details\"}}"),
        )
    }
}
