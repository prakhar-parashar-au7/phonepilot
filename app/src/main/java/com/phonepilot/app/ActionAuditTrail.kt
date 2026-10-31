package com.phonepilot.app

data class ActionAuditRecord(
    val timestampMillis: Long,
    val kind: String,
    val packageName: String,
    val index: Int?,
    val outcome: String,
    val reasonCode: String,
)

/** In-memory, metadata-only diagnostics. It deliberately has no task, label, or typed-text fields. */
class ActionAuditTrail(private val nowMillis: () -> Long = { System.currentTimeMillis() }) {
    private val entries = ArrayDeque<ActionAuditRecord>()

    @Synchronized
    fun record(kind: String, packageName: String, index: Int?, outcome: String, reasonCode: String) {
        entries += ActionAuditRecord(nowMillis(), kind, packageName, index, outcome, reasonCode)
        while (entries.size > MAX_ENTRIES) entries.removeFirst()
    }

    @Synchronized
    fun records(): List<ActionAuditRecord> = entries.toList()

    private companion object {
        const val MAX_ENTRIES = 50
    }
}
