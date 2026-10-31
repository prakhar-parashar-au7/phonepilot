# PhonePilot Floating Voice Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a sideloaded Android PhonePilot that accepts a push-to-talk task from a floating bubble and safely operates allowlisted apps through Android Accessibility, with decisions supplied by a server-held OpenAI API key.

**Architecture:** The pure `:core` loop remains platform independent; it gains validation and a two-stage confirmation action. The `:app` module supplies the Android Accessibility device adapter, foreground overlay, speech controller, setup UI, and a session coordinator. A separate Ktor `:backend` module accepts an authenticated action request, calls OpenAI Responses with strict JSON-schema output, and returns one validated action; the APK only stores a device token and backend URL.

**Tech Stack:** Kotlin 2.0/JVM 17, Android SDK 35/minSdk 30, AccessibilityService, TYPE_APPLICATION_OVERLAY foreground service, SpeechRecognizer, kotlinx.coroutines/serialization, Ktor server/client, OkHttp, OpenAI Responses API, JUnit5/kotlin.test.

**Spec:** `docs/superpowers/specs/2026-10-02-phonepilot-floating-agent-design.md`

## Global Constraints

- The finished app operates directly on the phone: no ADB, USB debugging, root, laptop process, or API key in the APK.
- The user manually grants Accessibility, overlay, microphone, and notification permissions; setup only deep-links and reports state.
- Initial locally editable allowlist: WhatsApp, Blinkit, Paytm, YouTube, and system UI.
- Send, call, purchase, delete, external share, and permission-change actions require a local explicit confirmation. STOP/cancel always wins.
- Allowed commands are open app, indexed tap/type, scroll, back/home, wait, ask user, and task complete; indices belong only to the latest snapshot and the cap is 25 actions.
- UI-tree text, not screenshots, is sent by default. Secure/thin trees, login/OTP/CAPTCHA, locked device, missing permissions, unsupported apps, API errors, and step cap stop safely with a specific reason.
- Local logs contain only timestamp, action type, target package, and success/failure: no credentials or raw typed-message content.

## Review Focus

- A stale element index must be rejected before Android performs any node action; Task 1 pins that result.
- A model response asking to send/purchase must not reach the device until the overlay’s local Confirm; Task 1 pins the pending-action state.
- A canceled coroutine or STOP tap must discard both a queued confirmation and all future actions; Task 5 pins cancellation.
- A missing/invalid device token or malformed provider result must produce no action and an explicit backend error; Task 6 pins both HTTP cases.
- UI roots that are null, locked, or from a non-allowlisted package must stop safely without guessing from a screenshot; Task 3 pins those paths.

---

## File Structure

```
phonepilot/
  core/.../model/AgentAction.kt                 # extend action contract (home + confirmation consequence)
  core/.../agent/ActionPolicy.kt                # pure action, allowlist and confirmation validation
  core/.../agent/Orchestrator.kt                # policy-aware, cancellable loop and events
  core/.../llm/ActionJson.kt                    # exact action JSON parsing/schema
  app/src/main/AndroidManifest.xml              # permissions, service and receiver declarations
  app/src/main/res/xml/phonepilot_accessibility.xml
  app/src/main/java/com/phonepilot/app/
    MainActivity.kt                             # permission/backend/allowlist setup screen
    SetupState.kt                               # injectable permission-state model
    PhonePilotAccessibilityService.kt           # root tree + node/global action adapter
    AccessibilityDeviceController.kt            # core DeviceController implementation
    OverlayService.kt                           # foreground bubble, status, confirm/cancel/STOP
    VoiceController.kt                          # SpeechRecognizer suspend adapter
    AgentSession.kt                             # binds voice, core loop, overlay, logs, network
    BackendLlmClient.kt                         # token-authenticated POST /v1/next-action
    AppPreferences.kt                           # encrypted/regular local configuration boundary
  backend/
    build.gradle.kts
    src/main/kotlin/com/phonepilot/backend/
      Application.kt                            # Ktor routing/auth/error mapping
      ActionRequest.kt                          # wire DTOs
      OpenAiResponsesClient.kt                  # server-only OpenAI Responses request
      ActionValidator.kt                        # request/action allowlist + schema guard
    src/test/kotlin/com/phonepilot/backend/...  # route/provider/validation tests
```

### Task 1: Make the pure agent contract safe and confirmation-aware

**Files:**
- Modify: `core/src/main/kotlin/com/phonepilot/core/model/AgentAction.kt`
- Create: `core/src/main/kotlin/com/phonepilot/core/agent/ActionPolicy.kt`
- Modify: `core/src/main/kotlin/com/phonepilot/core/agent/Orchestrator.kt`, `core/src/main/kotlin/com/phonepilot/core/llm/ActionJson.kt`, `core/src/main/kotlin/com/phonepilot/core/llm/PromptBuilder.kt`
- Test: `core/src/test/kotlin/com/phonepilot/core/agent/ActionPolicyTest.kt`, `core/src/test/kotlin/com/phonepilot/core/agent/OrchestratorTest.kt`, `core/src/test/kotlin/com/phonepilot/core/llm/ActionJsonTest.kt`

**Interfaces:**
- Produces `AgentAction.PressHome`, `AgentAction.AskUser(question: String, consequence: String)`, `PolicyDecision.Execute | Confirm(action, question, consequence) | Reject(reason)` and `Outcome.CONFIRMATION_REQUIRED`.
- `ActionPolicy.decide(action: AgentAction, snapshot: UiSnapshot): PolicyDecision` is called before every executable action.

- [ ] **Step 1: Write the failing core tests**

```kotlin
@Test fun staleTapIsRejected() {
    assertEquals(PolicyDecision.Reject("element #9 is not in current snapshot"),
        policy.decide(AgentAction.TapElement(9), snapshotWithIndices(0)))
}

@Test fun sendLikeTapRequiresConfirmation() {
    val result = policy.decide(AgentAction.TapElement(0), snapshotWithLabel("Send"))
    assertIs<PolicyDecision.Confirm>(result)
}

@Test fun askActionReturnsQuestionAndConsequence() {
    assertEquals(AgentAction.AskUser("Send it?", "This sends a WhatsApp message"),
        ActionJson.parse("{\"action\":\"ask\",\"question\":\"Send it?\",\"consequence\":\"This sends a WhatsApp message\"}"))
}
```

- [ ] **Step 2: Run the focused test task and confirm failure**

Run: `./gradlew :core:test --tests '*ActionPolicyTest' --tests '*ActionJsonTest'`

Expected: FAIL because `ActionPolicy`, `PressHome`, and the two-field `AskUser` do not exist.

- [ ] **Step 3: Implement the narrow contract and policy**

```kotlin
sealed interface PolicyDecision {
    data object Execute : PolicyDecision
    data class Confirm(val action: AgentAction, val question: String, val consequence: String) : PolicyDecision
    data class Reject(val reason: String) : PolicyDecision
}

class ActionPolicy(private val allowedPackages: Set<String>) {
    fun decide(action: AgentAction, snapshot: UiSnapshot): PolicyDecision = when (action) {
        is AgentAction.OpenApp -> if (action.pkg in allowedPackages) PolicyDecision.Execute
            else PolicyDecision.Reject("app is not allowed: ${action.pkg}")
        is AgentAction.TapElement, is AgentAction.TypeText -> validateIndexed(action, snapshot)
        else -> PolicyDecision.Execute
    }
}
```

Use `TreeSerializer.serialize(snapshot).index` to validate each index. Detect consequential node labels case-insensitively (`send`, `pay`, `place order`, `buy`, `call`, `delete`, `share`, `allow`) and return `Confirm`; do not use coordinates. Extend JSON parsing/schema and system prompt so the model must emit `ask` before a consequence. In `Orchestrator`, emit `AgentEvent.ConfirmationRequired`, return `CONFIRMATION_REQUIRED`, and never call `device.execute` for that action.

- [ ] **Step 4: Run all core tests**

Run: `./gradlew :core:test`

Expected: PASS, including existing agent-loop tests updated for the expanded sealed action hierarchy.

- [ ] **Step 5: Commit the core safety boundary**

```bash
git add core/src/main core/src/test
git commit -m "feat(core): gate consequential actions and validate snapshots"
```

### Task 2: Add the Android module dependencies, manifest, and permission-state setup

**Files:**
- Modify: `app/build.gradle.kts`, `app/src/main/AndroidManifest.xml`, `app/src/main/java/com/phonepilot/app/MainActivity.kt`
- Create: `app/src/main/res/xml/phonepilot_accessibility.xml`, `app/src/main/java/com/phonepilot/app/SetupState.kt`, `app/src/test/java/com/phonepilot/app/SetupStateTest.kt`

**Interfaces:**
- Produces `SetupState(accessibilityEnabled: Boolean, canDrawOverlays: Boolean, microphoneGranted: Boolean, notificationsGranted: Boolean)` and `SetupStateReader.read(): SetupState`.
- Declares `PhonePilotAccessibilityService` and `OverlayService`; neither auto-grants a permission.

- [ ] **Step 1: Write permission-state tests**

```kotlin
@Test fun readyOnlyWhenEveryManualCapabilityIsAvailable() {
    assertFalse(SetupState(true, true, true, false).ready)
    assertTrue(SetupState(true, true, true, true).ready)
}
```

- [ ] **Step 2: Run and confirm the app test fails**

Run: `./gradlew :app:testDebugUnitTest --tests '*SetupStateTest'`

Expected: FAIL because `SetupState` has not been created.

- [ ] **Step 3: Implement setup and declarations**

Add `implementation(project(":core"))`, coroutines Android, AndroidX activity/core, lifecycle service, and test dependencies. Declare `RECORD_AUDIO`, `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, and `SYSTEM_ALERT_WINDOW`. Register the accessibility service with `BIND_ACCESSIBILITY_SERVICE`, `android:canRetrieveWindowContent="true"`, `android:canPerformGestures="true"`, and a user-visible service description. `MainActivity` renders four state rows, opens `Settings.ACTION_ACCESSIBILITY_SETTINGS`, overlay settings, runtime microphone request, and notification permission request, then refreshes in `onResume`.

- [ ] **Step 4: Run unit tests and build the APK**

Run: `./gradlew :app:testDebugUnitTest :app:assembleDebug`

Expected: PASS and `app/build/outputs/apk/debug/app-debug.apk` exists.

- [ ] **Step 5: Commit foundation setup**

```bash
git add app/build.gradle.kts app/src
git commit -m "feat(app): add PhonePilot setup and permission declarations"
```

### Task 3: Implement the accessibility-backed `DeviceController`

**Files:**
- Create: `app/src/main/java/com/phonepilot/app/PhonePilotAccessibilityService.kt`, `app/src/main/java/com/phonepilot/app/AccessibilityDeviceController.kt`
- Test: `app/src/androidTest/java/com/phonepilot/app/AccessibilityDeviceControllerTest.kt`, `app/src/test/java/com/phonepilot/app/NodeActionMapperTest.kt`

**Interfaces:**
- Produces `AccessibilityDeviceController(serviceProvider: () -> PhonePilotAccessibilityService?): DeviceController`.
- `PhonePilotAccessibilityService.currentRoot(): AccessibilityNodeInfo?`, `foregroundPackage(): String?`, `performGlobalAction(action: Int): Boolean` are the sole Android boundary methods.

- [ ] **Step 1: Write mapper and null-root tests**

```kotlin
@Test fun nullServiceFailsWithoutAction() = runTest {
    assertEquals(ActionResult(false, "Accessibility service is not active"),
        controllerWithoutService.execute(AgentAction.PressBack))
}

@Test fun nullRootStopsSnapshotSafely() = runTest {
    assertFailsWith<DeviceUnavailableException> { controllerWithNullRoot.snapshot() }
}
```

- [ ] **Step 2: Run them to establish the failure**

Run: `./gradlew :app:testDebugUnitTest --tests '*NodeActionMapperTest'`

Expected: FAIL because the adapter and exception are absent.

- [ ] **Step 3: Implement tree conversion and actions**

Recursively map `AccessibilityNodeInfo` into the existing `UiNode`, copying text/contentDescription/className, clickable/editable, bounds, and children; always recycle framework nodes after copying. Snapshot package comes from `root.packageName`. For a current serialized index, retain a fresh index-to-node resolver only during `execute`; reject missing index with `ActionResult(false, "element #N is not in current snapshot")`. Use `ACTION_CLICK`, `ACTION_SET_TEXT` with `ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE`, `ACTION_SCROLL_FORWARD/BACKWARD`, and `GLOBAL_ACTION_BACK/HOME`; launch packages only through `packageManager.getLaunchIntentForPackage`. Return descriptive `ActionResult` values and reject a package outside the locally supplied allowlist.

- [ ] **Step 4: Add the instrumented safe-tap test and run tests**

`AccessibilityDeviceControllerTest` should assert the service connection is observable and, when a labelled harmless test Activity is foreground, tapping its `Safe target` node changes that Activity’s visible state. Run:

```bash
./gradlew :app:testDebugUnitTest :app:connectedDebugAndroidTest
```

Expected: JVM tests PASS; connected test PASS on the Pixel, or reports `No connected Android device` without treating it as a successful device verification.

- [ ] **Step 5: Commit the real phone adapter**

```bash
git add app/src/main app/src/test app/src/androidTest
git commit -m "feat(app): execute safe core actions through accessibility"
```

### Task 4: Build the foreground overlay and voice controller

**Files:**
- Create: `app/src/main/java/com/phonepilot/app/OverlayService.kt`, `app/src/main/java/com/phonepilot/app/VoiceController.kt`, `app/src/main/java/com/phonepilot/app/OverlayState.kt`
- Test: `app/src/test/java/com/phonepilot/app/OverlayStateTest.kt`, `app/src/androidTest/java/com/phonepilot/app/OverlayServiceTest.kt`

**Interfaces:**
- Produces `OverlayState.Idle | Listening | Working(message) | AwaitingConfirmation(question, consequence) | Paused(reason)`.
- `OverlayService.render(state)`, `OverlayService.events: Flow<OverlayEvent>` where events are `StartListening`, `Confirm`, `Cancel`, `Stop`.
- `VoiceController.listen(): Result<String>` returns a final, nonblank transcript or a specific failure.

- [ ] **Step 1: Write state-transition tests**

```kotlin
@Test fun stopFromAnyActiveStateReturnsIdleAndClearsConfirmation() {
    assertEquals(OverlayState.Idle, reducer.reduce(OverlayState.AwaitingConfirmation("Send?", "Sends message"), OverlayEvent.Stop))
}
```

- [ ] **Step 2: Run the unit test and confirm failure**

Run: `./gradlew :app:testDebugUnitTest --tests '*OverlayStateTest'`

Expected: FAIL because `OverlayState` and reducer are absent.

- [ ] **Step 3: Implement minimal overlay and speech behavior**

`OverlayService` is a microphone foreground service (notification channel plus `startForeground`) and adds one `TYPE_APPLICATION_OVERLAY` view only after `Settings.canDrawOverlays`. Its bubble starts listening; active panels show transcript/status, Confirm, Cancel, and STOP. It removes views and cancels its `CoroutineScope` in `onDestroy`. `VoiceController` creates `SpeechRecognizer`, requests `LANGUAGE_MODEL_FREE_FORM`, completes only on `onResults`, and maps permission/error codes to messages; it destroys the recognizer in `finally`.

- [ ] **Step 4: Verify**

Run: `./gradlew :app:testDebugUnitTest :app:assembleDebug`

Manual Pixel check: enable overlay, start the service from setup, tap bubble, speak “open WhatsApp”, then press STOP while listening. Expected: visible Listening state followed by Idle; no action occurs.

- [ ] **Step 5: Commit overlay/voice components**

```bash
git add app/src
git commit -m "feat(app): add voice-controlled floating overlay"
```

### Task 5: Coordinate a cancellable session, confirmation, preferences, and redacted logs

**Files:**
- Create: `app/src/main/java/com/phonepilot/app/AgentSession.kt`, `app/src/main/java/com/phonepilot/app/AppPreferences.kt`, `app/src/main/java/com/phonepilot/app/ActionLog.kt`
- Test: `app/src/test/java/com/phonepilot/app/AgentSessionTest.kt`, `app/src/test/java/com/phonepilot/app/ActionLogTest.kt`

**Interfaces:**
- Produces `AgentSession.start(task: String)`, `confirm()`, `cancel()`, `stop()`; only `confirm()` may execute a stored `PolicyDecision.Confirm.action`.
- `AppPreferences.allowedPackages: Set<String>`, `backendUrl: String`, `deviceToken: String`; `ActionLog.record(action, packageName, success)`.

- [ ] **Step 1: Write session safety tests**

```kotlin
@Test fun confirmationDoesNotExecuteBeforeConfirm() = runTest {
    session.start("send hi")
    advanceUntilIdle()
    assertEquals(0, fakeDevice.executed.size)
    session.confirm()
    assertEquals(1, fakeDevice.executed.size)
}

@Test fun stopCancelsAndDropsPendingAction() = runTest {
    session.start("send hi"); advanceUntilIdle(); session.stop(); session.confirm()
    assertEquals(0, fakeDevice.executed.size)
}

@Test fun logDoesNotContainTypedText() {
    assertFalse(log.render().contains("super-secret message"))
}
```

- [ ] **Step 2: Run and confirm failure**

Run: `./gradlew :app:testDebugUnitTest --tests '*AgentSessionTest' --tests '*ActionLogTest'`

Expected: FAIL because these classes do not exist.

- [ ] **Step 3: Implement orchestration**

Create a main-thread `AgentSession` with a child `SupervisorJob`. It starts only when setup is ready, gives `Orchestrator` the accessibility controller, backend client, and current allowed packages, maps every `AgentEvent` to `OverlayState`, and persists a pending confirmation in memory only. `confirm` checks the active session id before executing exactly once; cancel/STOP clear it then cancel the job. Store preferences using DataStore, expose an editable comma-separated package list in `MainActivity`, and use encrypted storage for the device token. Write JSONL log rows that omit `TypeText.text` and confirmation question contents.

- [ ] **Step 4: Run all JVM tests**

Run: `./gradlew :core:test :app:testDebugUnitTest`

Expected: PASS; no test relies on Android Accessibility being enabled.

- [ ] **Step 5: Commit session safety**

```bash
git add app/src
git commit -m "feat(app): coordinate cancellable confirmed agent sessions"
```

### Task 6: Add the server-held-key backend

**Files:**
- Modify: `settings.gradle.kts`, `build.gradle.kts`
- Create: `backend/build.gradle.kts`, `backend/src/main/kotlin/com/phonepilot/backend/{Application.kt,ActionRequest.kt,ActionValidator.kt,OpenAiResponsesClient.kt}`
- Test: `backend/src/test/kotlin/com/phonepilot/backend/{ApplicationTest.kt,ActionValidatorTest.kt,OpenAiResponsesClientTest.kt}`

**Interfaces:**
- Produces `POST /v1/next-action` authenticated by `Authorization: Bearer <device-token>`.
- Request: `{task, foregroundPackage, serializedTree, history}`; response: `{action: {...}}` or `{error: {code, message}}`.

- [ ] **Step 1: Write route and validation tests**

```kotlin
@Test fun unauthorizedRequestCannotReachProvider() = testApplication {
    val response = client.post("/v1/next-action") { setBody(validRequestJson) }
    assertEquals(HttpStatusCode.Unauthorized, response.status)
    assertEquals(0, fakeProvider.calls)
}

@Test fun invalidProviderActionReturnsBadGateway() = testApplication {
    fakeProvider.reply = "{\"action\":\"wipe_phone\"}"
    assertEquals(HttpStatusCode.BadGateway, client.authorizedPost(validRequestJson).status)
}
```

- [ ] **Step 2: Run backend tests to confirm failure**

Run: `./gradlew :backend:test`

Expected: FAIL because the `:backend` module is not included.

- [ ] **Step 3: Implement Ktor endpoint and OpenAI Responses client**

Add `include(":backend")`; configure Ktor Netty, server content negotiation, and test host dependencies. Read `OPENAI_API_KEY`, `PHONEPILOT_DEVICE_TOKEN`, and optional `PORT` only from the process environment; fail startup with a clear message if secret values are blank. Compare bearer tokens with constant-time bytes. Build an OpenAI Responses request with a system instruction that exactly mirrors `ActionJson.schemaDoc()`, the supplied compact tree/history, `temperature: 0`, and `text.format` strict JSON schema. Parse the provider’s output, pass it through the same `ActionJson` semantics (moved/shared without bringing Android into backend), reject unknown action types or malformed fields, and map timeout/provider transport to `502` JSON errors. Never log Authorization, environment values, raw task text, or the serialized tree.

- [ ] **Step 4: Run all backend tests**

Run: `./gradlew :backend:test`

Expected: PASS for auth, malformed JSON, disallowed action, successful strict action, and provider timeout mapping.

- [ ] **Step 5: Commit backend**

```bash
git add settings.gradle.kts build.gradle.kts backend
git commit -m "feat(backend): add authenticated OpenAI action endpoint"
```

### Task 7: Connect the Android app to the backend and complete device acceptance

**Files:**
- Create: `app/src/main/java/com/phonepilot/app/BackendLlmClient.kt`
- Modify: `app/src/main/java/com/phonepilot/app/{MainActivity.kt,AgentSession.kt,AppPreferences.kt}`
- Test: `app/src/test/java/com/phonepilot/app/BackendLlmClientTest.kt`
- Create: `docs/manual-tests/floating-agent-device-acceptance.md`

**Interfaces:**
- Produces `BackendLlmClient(baseUrl: String, deviceToken: String): LlmClient`; it sends no screenshots and never sends an OpenAI API key.

- [ ] **Step 1: Write HTTP-client tests**

```kotlin
@Test fun requestUsesDeviceBearerTokenAndNoApiKey() = runTest {
    client.nextAction(context)
    assertEquals("Bearer device-abc", recorded.header("Authorization"))
    assertNull(recorded.header("OpenAI-Api-Key"))
    assertFalse(recorded.body.readUtf8().contains("screenshot"))
}
```

- [ ] **Step 2: Run and confirm failure**

Run: `./gradlew :app:testDebugUnitTest --tests '*BackendLlmClientTest'`

Expected: FAIL because `BackendLlmClient` is absent.

- [ ] **Step 3: Implement client and configuration**

Use OkHttp with 20-second connect/read timeouts. Serialize `LlmContext` into the backend DTO, attach only the device bearer token, parse the returned action through core `ActionJson`, and turn any non-2xx/error field into an `LlmTransportException` with a user-safe message. Add backend URL and token fields to the setup screen; disable Start until URL is HTTPS and token is nonblank. Ensure logs redact both fields.

- [ ] **Step 4: Run automated verification**

Run: `./gradlew :core:test :app:testDebugUnitTest :backend:test :app:assembleDebug`

Expected: all suites PASS and a fresh debug APK is produced.

- [ ] **Step 5: Execute and record the Pixel acceptance checklist**

In `docs/manual-tests/floating-agent-device-acceptance.md`, record device/build/date and each result for: clean install; manually enabling all permissions; bubble lifecycle; speech transcript; safe test node tap; STOP during work; a WhatsApp “find Shikhar” navigation; and a send request stopping at local confirmation until Confirm is tapped. Verify no message is sent during the pre-confirmation observation. Include failure reproduction steps for locked phone, missing accessibility service, network-off, and an allowlist-rejected package.

- [ ] **Step 6: Commit integration and acceptance evidence**

```bash
git add app/src app/src/test docs/manual-tests
git commit -m "feat(app): connect PhonePilot to secure action backend"
```

### Task 8: Final release verification and operational documentation

**Files:**
- Create: `README.md`, `.env.example`, `docs/operations/backend-runbook.md`
- Modify: `.gitignore`

**Interfaces:**
- Documents local backend launch with environment variable names only, sideload/permission setup, and safe shutdown. `.env`, tokens, APK signing files, and local logs stay untracked.

- [ ] **Step 1: Write documentation assertions as a review checklist**

Add a `README` checklist containing these exact checks: API key is only in backend environment; ChatGPT Plus is not API access; overlay/Accessibility must be enabled manually; STOP prevents further actions; Confirm is required for sending/paying. Review `.env.example` contains names but no values:

```dotenv
OPENAI_API_KEY=
PHONEPILOT_DEVICE_TOKEN=
PORT=8080
```

- [ ] **Step 2: Run repository secret and hygiene checks**

Run: `rg -n --hidden --glob '!**/.git/**' '(sk-[A-Za-z0-9]|OPENAI_API_KEY=.+|PHONEPILOT_DEVICE_TOKEN=.+)' .`

Expected: no secret value; only variable references and the blank `.env.example` entries.

- [ ] **Step 3: Document and verify release commands**

`backend-runbook.md` must give the exact commands:

```bash
export OPENAI_API_KEY='set-in-shell'
export PHONEPILOT_DEVICE_TOKEN='set-a-long-random-token'
./gradlew :backend:run
./gradlew :app:assembleDebug
```

Run: `./gradlew :core:test :app:testDebugUnitTest :backend:test :app:assembleDebug`

Expected: PASS.

- [ ] **Step 4: Commit the release handoff**

```bash
git add README.md .env.example .gitignore docs/operations
git commit -m "docs: add PhonePilot setup and backend runbook"
```

## Self-review

Spec coverage is mapped as follows: phone-native and permissions (Task 2), real tree/device actions (Task 3), bubble/speech/STOP (Tasks 4–5), indexed action and confirmation safety (Task 1 and Task 5), no client key plus server endpoint (Tasks 6–7), redacted logs/failure modes (Tasks 3, 5, 6), and Pixel acceptance without automatic send (Task 7). Screenshot/vision fallback is intentionally absent, as required by the first milestone.

No incomplete or deferred implementation markers appear in task instructions. Later task interfaces match their defining tasks: `PolicyDecision`, `OverlayState`, `AgentSession`, and `BackendLlmClient` retain the same names and responsibilities. The five review-focus failure classes each have an explicit test in Tasks 1, 3, 5, and 6.
