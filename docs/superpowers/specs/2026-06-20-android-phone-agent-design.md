# PhonePilot — Native Android Phone-Control Agent

**Date:** 2026-06-20
**Status:** Approved design, ready for implementation planning

## Summary

PhonePilot is a native Android app that acts as a voice-driven agent able to
perceive the screen, reason about it with Claude, and operate arbitrary apps on
the user's behalf — opening apps, tapping buttons, typing, and moving content
between apps. The north-star task: *"send this YouTube video link to Ayush on
WhatsApp"* — spoken aloud, executed autonomously.

It is "Anthropic's computer-use paradigm, ported to a real Android phone."

## Goals

- Run **natively on a physical Android phone** as an installable APK.
- Accept **voice commands** (speech-to-text) from day one, and reply by voice.
- **See the screen** (UI element tree + screenshots) and **act** on it (taps,
  typing, scrolling, app-switching) system-wide, no root required.
- Use the **cloud Claude API** as the reasoning brain via a tool-use loop.
- Operate across multiple apps to complete multi-step tasks.
- Be safe: confirm consequential actions, cap runaway loops, always stoppable.

## Non-Goals (for the MVP)

- On-device / offline reasoning model.
- Play Store distribution (AccessibilityService usage is heavily restricted
  there; MVP is sideloaded for personal use).
- Supporting every app on day one — v1 uses an app allowlist.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Target | Real APK on a physical phone | User has a device; Android Studio installed as part of setup |
| Brain | Cloud LLM via a **provider-agnostic `LlmClient`** | Claude / OpenRouter / any OpenAI-compatible endpoint behind one interface; swap models with one config change |
| POC brain | **Free-tier model** (OpenRouter free open model, or Gemini Flash free tier as fallback) | Gets a running POC at ~$0; Haiku is the paid reliability fallback |
| Input | Voice from day one | Matches the "talk to it" vision |
| Perception/action | **Hybrid target** (UI tree + screenshot), but **POC ships tree-only first** | Tree-only is text (near-free, no vision model needed); screenshots layered back in after the loop works |
| Language / UI | Kotlin + Jetpack Compose | Standard modern Android |
| `minSdk` | 30 (Android 11) | `AccessibilityService.takeScreenshot()` avoids MediaProjection consent-per-session |
| API/JSON | OkHttp + kotlinx.serialization | Lightweight, no heavy framework |
| Secrets | `EncryptedSharedPreferences` | API key never hardcoded |

## Architecture

Single Android app module. Seven components:

1. **`AgentAccessibilityService`** (the eyes & hands)
   - Reads `rootInActiveWindow`, serializes each element: text,
     contentDescription, className, `clickable`/`editable` flags, on-screen
     bounds, and an assigned stable index.
   - Captures screenshots via `takeScreenshot()` (API 30+).
   - Performs actions: `ACTION_CLICK` / `ACTION_SET_TEXT` /
     `ACTION_SCROLL_FORWARD` directly on nodes; `dispatchGesture` for
     coordinate taps & swipes; global actions (back / home / recents).
   - Launches apps via package-manager intents.
   - Enabling it is a **manual one-time toggle** in Android Settings — the OS
     forbids self-granting. The setup wizard deep-links the user there.

2. **`Orchestrator`** (the perceive → think → act loop)
   - Captures state → calls Claude → executes the returned action → feeds back
     the result → repeats until `task_complete`, `ask_user`, an error, or the
     step cap.
   - Talks to the device **only through a `DeviceController` interface** (see
     Testing), never to Android directly — this keeps the brain headless-testable.

3. **`ClaudeClient`** (the brain wrapper)
   - Wraps the Anthropic Messages API as a **tool-use conversation**.
   - Encodes the screenshot as an image block and the serialized tree as text.
   - Handles the system prompt, retries, and tool-call parsing.

4. **`VoiceManager`**
   - `SpeechRecognizer` for speech → text command.
   - `TextToSpeech` for spoken status and replies.

5. **Floating overlay bubble** (`TYPE_APPLICATION_OVERLAY`)
   - Because the agent drives *other* apps, PhonePilot itself is backgrounded
     while it works. The bubble floats on top showing the current step and an
     always-available **STOP** button; it also hosts the mic trigger.

6. **Control UI (Jetpack Compose)**
   - Setup wizard (enable accessibility, overlay, mic, enter API key).
   - Task input.
   - Live scrolling log of each step ("Opened YouTube → Tapped Share → …").

7. **Safety / Confirmation layer**
   - Gates consequential actions behind a one-tap/voice confirmation.

### The agent's action vocabulary (Claude tools)

`open_app`, `tap_element`, `tap_xy`, `type_text`, `scroll`, `swipe`,
`press_back`, `press_home`, `copy_text`, `wait`, `ask_user`, `task_complete`.

Each is a Claude tool definition. `tap_element` targets a node by its assigned
index (preferred, robust); `tap_xy` is the coordinate fallback for elements
absent from the tree.

## Data Flow (one task)

```
Voice "send this YouTube link to Ayush"
  └─► STT → instruction text
       └─► Orchestrator loop, each step:
            1. Service captures: element tree (indexed text) + screenshot (downscaled, base64)
            2. ClaudeClient → Anthropic Messages API (system prompt + task + tree + image)
            3. Claude returns a tool call, e.g. open_app{com.google.android.youtube}
            4. Executor runs it on the device; returns success / new state
            5. Result fed back to Claude → next step
       └─► Claude calls task_complete (or ask_user) → TTS speaks result
```

## Permissions & Setup (wizard order)

1. **Accessibility Service** — manual toggle in Settings (deep-linked). Required.
2. **Draw over other apps** (`SYSTEM_ALERT_WINDOW`) — floating bubble.
3. **Microphone** (`RECORD_AUDIO`) — runtime permission, for voice.
4. **Internet** — for the API.
5. **API key** — entered once, stored in `EncryptedSharedPreferences`.

`takeScreenshot()` needs no extra permission for an accessibility service on
API 30+.

## Safety Guardrails

- **Confirmation gate** on consequential actions (send message, place call,
  purchase, delete). Claude flags these; the bubble asks "Send to Ayush? ✓ / ✗"
  (tap or voice) before executing. Toggleable.
- **Step cap** (default ~25) prevents runaway loops.
- **Always-on STOP** — bubble button and voice "stop" both hard-abort instantly.
- **App allowlist for v1** — YouTube, WhatsApp, system UI only; expandable.
- **Dry-run mode** — logs intended actions without performing them, for safe
  development iteration.
- **Full action log** — every step recorded and surfaced; never a black box.

## Testing Strategy

- The live Android service can't be unit-tested cleanly, so the device is hidden
  behind a **`DeviceController` interface**. The `Orchestrator` depends on that
  interface only.
- This makes the brain **headless-testable** (TDD):
  - `Orchestrator` state machine against a **fake `DeviceController`** + **fake /
    recorded Claude responses**.
  - `ClaudeClient` tool-call parsing.
  - **Tree serialization** (UI tree → compact text) as pure logic.
- The real `AgentAccessibilityService` is validated by **manual on-device runs**
  plus dry-run mode. Keep this untested surface as thin as possible.

## Phased MVP — Definition of Done

- **Phase 1 — Skeleton & permissions.** App installs; setup wizard turns all
  permissions green; the user speaks a command and sees it correctly transcribed
  on screen. No agent actions yet.
- **Phase 2 — Single-app loop.** Full perceive→think→act loop *within one app*:
  "open YouTube and search for lo-fi beats" executes end-to-end with real taps.
  Proves hybrid perception + Claude tool-loop + node/coordinate actions.
- **Phase 3 — Cross-app north star.** The full *"share this YouTube link to
  Ayush on WhatsApp"* flow, app-switching included, with the confirmation gate
  before the message sends.

Each phase is independently demoable on the phone.

## POC-First Sequencing (cheapest running version)

The design target is the full hybrid agent. To get a *running* POC at ~$0 and
de-risk cheaply, we sequence the build:

1. **Spike (no app built):** dump YouTube's and WhatsApp's accessibility trees
   over `adb` (`spike/treedump.py`, `uiautomator dump`) to confirm tree-only is
   viable on the target apps. This validates Risk #1 before writing app code.
2. **POC = Phase 1 + Phase 2, tree-only, free-tier model.** No screenshots, no
   vision model — a few hundred tokens/step, effectively free.
3. **Then** layer screenshots + vision back in (the full hybrid) for Phase 3, and
   let the user pick the production brain (a one-line `LlmClient` swap).

## Cost Analysis (POC)

**Cash: ~$0–5 total.**

| Item | Cost | Notes |
|------|------|-------|
| Android Studio + SDK | $0 | Free |
| Physical device | $0 | Already owned |
| Distribution | $0 | Sideload via USB; no Play Store fee |
| LLM API (dev) | ~$0 | Tree-only is text; free tier covers it. Paid Haiku fallback ≈ $1–3 for hundreds of dev runs |

**Effort concentrates in the untestable on-device surface.** Headless parts
(`Orchestrator`, `TreeSerializer`, `LlmClient`) are TDD'd and cheap. The
`AgentAccessibilityService` + on-device debugging is the real time sink (size L).

## Risk Pre-Mortem & Workarounds

**The three risks that decide success:** (1) tree quality on the target apps
[de-risked by the spike, before building], (2) timing/sync — acting before the
UI settles, (3) cheap-model JSON reliability [Haiku is the safety net].

**Phase 1 — Permissions & skeleton**

| Blocker | Workaround |
|---------|-----------|
| OEM disables the accessibility service (Xiaomi/Samsung/OnePlus battery & autostart) | Foreground service + persistent notification; battery-optimization exemption; wizard documents OEM autostart; detect-when-disabled + re-prompt |
| Continuous voice / wake-word complexity | **Push-to-talk** via the bubble for the POC — no wake word |

**Phase 2 — Single-app tree-only loop (POC core)**

| Blocker | Workaround |
|---------|-----------|
| Thin element tree (Compose/WebView/canvas) | Pick native, well-labelled apps for POC; vision is the Phase-3 escape hatch |
| `ACTION_SET_TEXT` doesn't "take" | Ladder: `SET_TEXT` → `IME_ENTER`; or **clipboard paste** (`ACTION_PASTE`), also needed for "copy the link" |
| Loop reads tree before UI settles → stale state | Wait-for-idle on `WINDOW_CONTENT_CHANGED`/`WINDOW_STATE_CHANGED` + debounce + `wait` tool + retry-if-unchanged |
| Unstable element indices across steps | **Re-index every step**; never persist; LLM references only current indices |
| Cheap model emits bad JSON / hallucinates an index | Strict schema validation + reprompt; constrain to current valid indices; fall back to Haiku |
| Free-tier rate limits / availability | Agnostic `LlmClient` with fallback chain (free → paid Haiku); budget ~$3 |

**Phase 3 — Cross-app + vision**

| Blocker | Workaround |
|---------|-----------|
| `FLAG_SECURE` screens → black screenshot | Rely on tree where vision is blocked; hardened apps (banking) out of scope |
| `takeScreenshot()` rate-limited (~1/s) | Pace captures; tree-first gating; cache last image |
| Coordinate-tap offset (insets, split-screen, density) | Derive taps from node `Rect` bounds, not guessed coords |
| Wrong app foregrounded after switch | Verify foreground package after `open_app`; retry; LLM re-perceives and self-corrects |
| Popups/ads/interstitials | Reactive loop is a strength — LLM sees and dismisses; not brittle like scripts |
| Login walls / 2FA / captcha | `ask_user` hands control back; assume logged-in apps |

**Later / productionization (flagged, not POC)**

| Blocker | Workaround |
|---------|-----------|
| Play Store bans AccessibilityService for non-accessibility use | Sideload for personal use; never plan on Play distribution |
| Abuse surface (app can tap anything) | Confirmation gate + app allowlist + audit log (already in design) |
| Latency UX (1–3s round-trip/step) | Tree-only + fast provider (Groq); minimize steps; bubble/TTS progress |

## Proposed Project Structure

```
phonepilot/
  app/
    src/main/java/.../phonepilot/
      service/    AgentAccessibilityService, TreeSerializer, ActionExecutor, DeviceController
      agent/      Orchestrator, AgentState, step/action models
      claude/     ClaudeClient, request/response models, tool definitions, prompts
      voice/      VoiceManager
      ui/         Compose screens, overlay bubble, setup wizard
      data/       settings, EncryptedSharedPreferences storage
    src/test/     headless tests (Orchestrator, ClaudeClient, TreeSerializer)
  docs/superpowers/specs/
```
