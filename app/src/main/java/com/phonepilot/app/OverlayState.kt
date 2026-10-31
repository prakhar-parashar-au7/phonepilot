package com.phonepilot.app

sealed interface OverlayState {
    data object Idle : OverlayState
    data class Working(
        val message: String,
        val shownAtMillis: Long = 0,
        val timeoutMillis: Long = DEFAULT_TIMEOUT_MILLIS,
    ) : OverlayState

    fun stop(): OverlayState = Idle

    fun at(nowMillis: Long): OverlayState = when (this) {
        Idle -> Idle
        is Working -> if (nowMillis - shownAtMillis >= timeoutMillis) Idle else this
    }

    companion object {
        const val DEFAULT_TIMEOUT_MILLIS = 3_500L
    }
}
