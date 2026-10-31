# PhonePilot Floating Voice Agent — Design

**Date:** 2026-10-02  
**Status:** Approved for implementation planning

## Intent

PhonePilot is a sideloaded personal Android app that runs directly on the
phone. A floating push-to-talk bubble accepts a spoken task, then uses Android
Accessibility APIs to inspect and operate other allowed apps. It does not use
ADB, USB debugging, root, or a laptop after its one-time setup.

The first usable version performs real, reversible navigation and drafting
actions. It requires a local confirmation before consequential actions:
sending a message, placing a call, purchasing, deleting, sharing externally,
or changing a permission.

## Non-negotiable constraints

- The user manually enables Accessibility, overlay, microphone, and
  notifications permissions. Android does not permit the app to grant these
  permissions to itself.
- The Android APK contains no LLM-provider API key.
- ChatGPT Plus is not an API credential. OpenAI API usage needs separately
  configured API billing and a server-held API key.
- Initial allowlist: WhatsApp, Blinkit, Paytm, YouTube, and system UI. The
  list is stored locally and editable by the user.
- The agent is always interruptible through an overlay STOP control.

## Architecture

```
Bubble tap
  -> SpeechRecognizer produces task text
  -> AgentSession runs the loop
  -> HTTPS backend asks OpenAI for one structured action
  -> AccessibilityDeviceController executes or asks for confirmation
  -> fresh UI snapshot returns to the backend
  -> TaskComplete / AskUser / error
```

### Android app

`MainActivity` becomes a setup and settings screen. It guides the user through
the four manual permissions and pairs the app with the backend using a
device-scoped token.

`PhonePilotAccessibilityService` is the device boundary. It implements
`DeviceController` by reading `rootInActiveWindow`, serializing the active app
tree, and performing node actions. It launches apps using package intents,
uses node actions first for tap/text/scroll, and supports global Back/Home.
No ADB command or host-machine process is involved.

`OverlayController` is a foreground service that owns a small
`TYPE_APPLICATION_OVERLAY` bubble. Tap starts push-to-talk. While a task is
active it displays status, Confirm, Cancel, and STOP. STOP cancels the current
coroutine and discards pending actions.

`VoiceController` wraps Android `SpeechRecognizer` with `RECORD_AUDIO` and
returns the final transcript to `AgentSession`. Text-to-speech is optional
status feedback, not part of task correctness.

`AgentSession` adapts the existing pure-JVM `Orchestrator` to the Android
service and the remote LLM client. It updates the overlay from `AgentEvent`s.

### LLM backend

The backend is a small HTTPS service. It holds `OPENAI_API_KEY` in its server
environment, authenticates one registered phone by a device token, and exposes
one endpoint: `POST /v1/next-action`.

Request fields: task, active package, indexed serialized UI tree, and prior
action/result steps. Screenshot bytes are omitted by default. A later
vision-fallback request may include a downscaled screenshot only when the tree
cannot identify the needed control.

The backend uses the OpenAI Responses API and a strict JSON schema to return
exactly one action. It does not execute actions itself. It validates that the
action type is known and returns a structured error for model or provider
failures. Provider transport remains hidden behind the existing `LlmClient`
interface so a future provider can be substituted without changing the loop.

### Action contract

The only executable actions are:

- `open_app(packageName)`
- `tap_element(index)`
- `type_text(index, text)`
- `scroll(direction)`
- `press_back`
- `press_home`
- `wait(milliseconds)`
- `ask_user(question, consequence)`
- `task_complete(summary)`

Element indexes belong only to the current snapshot. The phone captures a new
snapshot after every action. The agent rejects indexes absent from that snapshot,
apps outside the allowlist, and loops beyond 25 actions.

The backend must return `ask_user` before a consequential action. The overlay
shows the target and consequence; a local Confirm button or an explicit spoken
confirmation is required before `AgentSession` executes the pending action.
Cancel ends the task. The backend cannot bypass this local gate.

## Failure handling

- Inactive accessibility service, missing overlay/mic permission, locked
  device, login/OTP/CAPTCHA, disallowed app, unavailable UI root, network/API
  error, or step cap pauses the task and reports a specific reason.
- Screens with a thin or secure accessibility tree stop safely in the initial
  build. Screenshot/vision fallback is a later addition, never a silent
  substitute.
- The app records a local, redacted action log containing action type, target
  package, and success/failure. It never records credentials or raw message
  contents beyond what is necessary for a confirmation summary.

## Scope and acceptance criteria

### First implementation milestone

1. App installs on the Pixel without ADB required at runtime.
2. Setup shows the state of all permissions and deep-links to the relevant
   Android settings pages.
3. Enabling the overlay shows the bubble above other apps.
4. Bubble push-to-talk transcribes a spoken task and presents the transcript.
5. Accessibility service can snapshot a permitted app and perform a verified
   non-consequential action through `DeviceController`.
6. STOP cancels an active session.
7. Sending a WhatsApp message reaches a local confirmation prompt rather than
   sending automatically.

### Tests

- JVM unit tests: action validation, confirmation gating, step cap, and
  malformed LLM replies through the current pure-Kotlin core.
- Android instrumentation/manual checks: service connection, overlay lifecycle,
  permission-state detection, speech transcript delivery, and one safe node
  tap.
- Device acceptance: "open WhatsApp and find Shikhar" navigates to the direct
  chat; a subsequent send request presents a confirmation and does not send
  until Confirm is tapped.

## Delivery sequence

1. Android foundation: manifest, accessibility metadata/service, overlay
   foreground service, and permission setup screen.
2. Implement Android `DeviceController` and test it against a safe app.
3. Wire voice input and session/status overlay.
4. Add confirmation gate and allowlist enforcement.
5. Add the standalone OpenAI-backed backend and phone pairing configuration.
6. Run the device acceptance scenario. Screenshot/vision fallback follows only
   after the tree-first path works.
