# PhonePilot Autonomous Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely execute multi-step navigation, typing, and explicit named-recipient sends without routine confirmation prompts.

**Architecture:** Core owns indexed UI fingerprints, request sessions, task intent, and policy. Android captures a session before each Worker decision and verifies the same element against a fresh Accessibility snapshot before tap/type/send. The Worker may recommend text entry; Android remains authoritative for local field safety, allowed packages, explicit-send intent, stale UI rejection, and privacy-safe auditing.

**Tech Stack:** Kotlin/JVM Android Accessibility Service, Kotlin unit tests, TypeScript Cloudflare Worker, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-03-phonepilot-autonomous-execution-design.md`

## Global Constraints

- Never transmit sensitive task, history, or UI text to the Worker.
- Never type into password, OTP, payment, banking, or login fields.
- Android enforces package allowlisting and stale UI checks; the Worker does not.
- Automatic send needs both explicit send intent and a named recipient in the voice task.
- Audit records must not include task text, labels, typed text, tokens, or provider bodies.
- Orders, payments, deletion, permission, share, and call actions remain blocked or confirmed.

## Review Focus

- Changed UI index must reject rather than tap an arbitrary control (Task 2).
- Sensitive-looking editable labels must reject typing locally (Task 3).
- An unallowlisted `open_app` is discarded locally (Task 4).
- A missing send verb or recipient never taps Send (Task 4).
- Audit records never include private content and stay bounded (Task 5).

---

### Task 1: Privacy-safe UI request sessions

**Files:**
- Create: `core/src/main/kotlin/com/phonepilot/core/agent/UiActionSession.kt`
- Create: `core/src/test/kotlin/com/phonepilot/core/agent/UiActionSessionTest.kt`

**Interfaces:** `UiActionSession.capture(snapshot: UiSnapshot): UiActionSession`; `UiActionSession.matches(index: Int, fresh: UiSnapshot): Boolean`.

- [ ] **Step 1: Write failing tests**

```kotlin
@Test fun `matching indexed element is accepted`() {
    val session = UiActionSession.capture(snapshot(button("Search")))
    assertTrue(session.matches(0, snapshot(button("Search"))))
}
@Test fun `changed label bounds package or edit state rejects index`() {
    val session = UiActionSession.capture(snapshot(button("Search")))
    assertFalse(session.matches(0, snapshot(button("Buy"))))
}
```

- [ ] **Step 2: Run RED**

Run: `./gradlew :core:test --tests '*UiActionSessionTest'`

Expected: FAIL because `UiActionSession` does not exist.

- [ ] **Step 3: Implement immutable fingerprint capture**

```kotlin
data class UiElementFingerprint(
  val packageName: String, val role: String, val bounds: Bounds,
  val clickable: Boolean, val editable: Boolean, val labelHash: String?
)
data class UiActionSession(private val elements: Map<Int, UiElementFingerprint>)
```

Use `TreeSerializer.serialize` for identical index ordering. Hash non-sensitive labels with SHA-256 and never store raw labels.

- [ ] **Step 4: Run GREEN and commit**

Run: `./gradlew :core:test --tests '*UiActionSessionTest'`

Expected: PASS.

```bash
git add core/src/main/kotlin/com/phonepilot/core/agent/UiActionSession.kt core/src/test/kotlin/com/phonepilot/core/agent/UiActionSessionTest.kt
git commit -m "feat: retain privacy-safe UI action sessions"
```

### Task 2: Session-bound Android execution

**Files:**
- Modify: `core/src/main/kotlin/com/phonepilot/core/device/DeviceController.kt`
- Modify: `core/src/main/kotlin/com/phonepilot/core/agent/Orchestrator.kt`
- Modify: `app/src/main/java/com/phonepilot/app/AccessibilityDeviceController.kt`
- Modify: `core/src/test/kotlin/com/phonepilot/core/agent/OrchestratorTest.kt`
- Create: `app/src/test/java/com/phonepilot/app/AccessibilityActionSessionTest.kt`

**Interfaces:** `DeviceController.captureActionSession(snapshot)` and `DeviceController.execute(action, session)`. `Orchestrator` captures the session from exactly the snapshot supplied to `LlmContext`.

- [ ] **Step 1: Write failing tests**

```kotlin
@Test fun `orchestrator executes against its decision session`() = runTest {
    assertEquals(session, fakeDevice.executedSession)
}
@Test fun `fresh changed indexed element returns stale UI action discarded`() = runTest {
    assertEquals("stale UI action discarded", controller.execute(AgentAction.TapElement(0), session).message)
}
```

- [ ] **Step 2: Run RED**

Run: `./gradlew :core:test :app:testDebugUnitTest --tests '*OrchestratorTest' --tests '*AccessibilityActionSessionTest'`

Expected: FAIL because execution accepts only `AgentAction`.

- [ ] **Step 3: Implement session validation**

Capture immediately before `llm.nextAction`. Before resolving an `AccessibilityNodeInfo` for tap/type, capture a fresh snapshot and return `ActionResult(false, "stale UI action discarded")` unless the session fingerprint exactly matches.

- [ ] **Step 4: Run GREEN and commit**

Run: `./gradlew :core:test :app:testDebugUnitTest --tests '*OrchestratorTest' --tests '*AccessibilityActionSessionTest'`

Expected: PASS.

```bash
git add core/src/main/kotlin/com/phonepilot/core/device/DeviceController.kt core/src/main/kotlin/com/phonepilot/core/agent/Orchestrator.kt app/src/main/java/com/phonepilot/app/AccessibilityDeviceController.kt core/src/test/kotlin/com/phonepilot/core/agent/OrchestratorTest.kt app/src/test/java/com/phonepilot/app/AccessibilityActionSessionTest.kt
git commit -m "feat: reject stale phone UI actions"
```

### Task 3: Automatic safe typing

**Files:**
- Modify: `worker/src/index.ts`
- Modify: `worker/test/index.test.ts`
- Create: `app/src/main/java/com/phonepilot/app/LocalActionSafety.kt`
- Create: `app/src/test/java/com/phonepilot/app/LocalActionSafetyTest.kt`
- Modify: `app/src/main/java/com/phonepilot/app/AccessibilityDeviceController.kt`

**Interfaces:** `LocalActionSafety.canType(node: UiNode): Boolean`; Worker strictly validates `type_text`, Android decides whether it executes.

- [ ] **Step 1: Write failing tests**

```kotlin
@Test fun `editable search permits automatic typing`() { assertTrue(LocalActionSafety.canType(searchNode)) }
@Test fun `password otp payment banking and login reject typing`() { assertFalse(LocalActionSafety.canType(passwordNode)) }
```

```ts
it("allows a schema-valid type_text recommendation for Android enforcement", async () => {
  expect((await worker.fetch(post(), env, ctx)).status).toBe(200)
})
```

- [ ] **Step 2: Run RED**

Run: `./gradlew :app:testDebugUnitTest --tests '*LocalActionSafetyTest' && (cd worker && npm test)`

Expected: FAIL because Worker currently rejects every `type_text` action.

- [ ] **Step 3: Implement local typing checks**

Remove only the Worker blanket `type_text` denial. Require a matching session, editable fresh node, safe label, and allowed package before `ACTION_SET_TEXT`.

- [ ] **Step 4: Run GREEN and commit**

Run: `./gradlew :app:testDebugUnitTest --tests '*LocalActionSafetyTest' && (cd worker && npm test)`

Expected: PASS.

```bash
git add worker/src/index.ts worker/test/index.test.ts app/src/main/java/com/phonepilot/app/LocalActionSafety.kt app/src/test/java/com/phonepilot/app/LocalActionSafetyTest.kt app/src/main/java/com/phonepilot/app/AccessibilityDeviceController.kt
git commit -m "feat: allow safe autonomous text entry"
```

### Task 4: Explicit-intent send policy

**Files:**
- Create: `core/src/main/kotlin/com/phonepilot/core/agent/TaskIntent.kt`
- Create: `core/src/test/kotlin/com/phonepilot/core/agent/TaskIntentTest.kt`
- Modify: `core/src/main/kotlin/com/phonepilot/core/agent/ActionPolicy.kt`
- Modify: `core/src/main/kotlin/com/phonepilot/core/agent/Orchestrator.kt`
- Modify: `core/src/test/kotlin/com/phonepilot/core/agent/ActionPolicyTest.kt`

**Interfaces:** `TaskIntent.from(task): TaskIntent(explicitSend: Boolean, recipient: String?)`; `ActionPolicy.decide(action, snapshot, taskIntent)`.

- [ ] **Step 1: Write failing tests**

```kotlin
@Test fun `send Shikhar hello has explicit send and recipient`() {
    assertEquals(TaskIntent(true, "Shikhar"), TaskIntent.from("send Shikhar hello"))
}
@Test fun `reply hello has no explicit recipient`() {
    assertEquals(null, TaskIntent.from("reply hello").recipient)
}
@Test fun `send button is blocked without explicit recipient`() {
    assertIs<PolicyDecision.Confirm>(policy.decide(sendTap, snapshot, TaskIntent(false, null)))
}
@Test fun `matching send button may execute for explicit named recipient`() {
    assertEquals(PolicyDecision.Execute, policy.decide(sendTap, snapshot, TaskIntent(true, "Shikhar")))
}
@Test fun `unallowlisted open app is rejected locally`() {
    assertIs<PolicyDecision.Reject>(policy.decide(AgentAction.OpenApp("com.other"), snapshot, TaskIntent(false, null)))
}
```

- [ ] **Step 2: Run RED**

Run: `./gradlew :core:test --tests '*TaskIntentTest' --tests '*ActionPolicyTest'`

Expected: FAIL because current policy has no task intent.

- [ ] **Step 3: Implement narrow send gate**

Recognize only clear `send`, `message`, or `text` verbs with a named recipient; missing/ambiguous parsing is non-send. Permit a send-like label only after explicit intent, package allowlisting, a matching session, and non-sensitive typed content. Preserve current restrictions for other consequential labels.

- [ ] **Step 4: Run GREEN and commit**

Run: `./gradlew :core:test --tests '*TaskIntentTest' --tests '*ActionPolicyTest'`

Expected: PASS.

```bash
git add core/src/main/kotlin/com/phonepilot/core/agent/TaskIntent.kt core/src/test/kotlin/com/phonepilot/core/agent/TaskIntentTest.kt core/src/main/kotlin/com/phonepilot/core/agent/ActionPolicy.kt core/src/main/kotlin/com/phonepilot/core/agent/Orchestrator.kt core/src/test/kotlin/com/phonepilot/core/agent/ActionPolicyTest.kt
git commit -m "feat: gate automatic sends on explicit intent"
```

### Task 5: Privacy-safe audit trail and release verification

**Files:**
- Create: `app/src/main/java/com/phonepilot/app/ActionAuditTrail.kt`
- Create: `app/src/test/java/com/phonepilot/app/ActionAuditTrailTest.kt`
- Modify: `app/src/main/java/com/phonepilot/app/OverlayService.kt`
- Modify: `README.md`

**Interfaces:** `ActionAuditTrail.record(kind, packageName, index, outcome, reasonCode)` retains at most 50 metadata-only records.

- [ ] **Step 1: Write failing tests**

```kotlin
@Test fun `trace excludes task labels and typed text`() {
    assertFalse(trail.records().toString().contains("private message"))
}
@Test fun `trace keeps at most fifty records`() {
    repeat(51) { trail.record("tap", "com.whatsapp", it, "executed", "ok") }
    assertEquals(50, trail.records().size)
}
```

- [ ] **Step 2: Run RED**

Run: `./gradlew :app:testDebugUnitTest --tests '*ActionAuditTrailTest'`

Expected: FAIL because no audit trail exists.

- [ ] **Step 3: Implement and document**

Record only timestamp, action kind, package, index, outcome, and reason code from overlay events. Document safe typing, stale-action rejection, explicit named-recipient sends, and prohibited sensitive fields.

- [ ] **Step 4: Run complete verification, install, and commit**

Run: `./gradlew :core:test :app:testDebugUnitTest :app:assembleDebug && (cd worker && npm test)`

Expected: all tests PASS and a debug APK is produced.

Run: `adb -s <wireless-device-id> install -r app/build/outputs/apk/debug/app-debug.apk`

Expected: existing app data remains; user re-enables Accessibility only if Android disables it after replacement.

```bash
git add app/src/main/java/com/phonepilot/app/ActionAuditTrail.kt app/src/test/java/com/phonepilot/app/ActionAuditTrailTest.kt app/src/main/java/com/phonepilot/app/OverlayService.kt README.md
git commit -m "feat: add privacy-safe phone action auditing"
```
