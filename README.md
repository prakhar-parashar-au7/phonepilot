# PhonePilot

**Computer use for a real Android phone.** Say a task — "add tomato to my Blinkit cart and go to checkout",
"say hi to Vaishnav on WhatsApp" — and an AI agent reads the phone's screen and taps/types through real apps
until it's done. Anything that spends money or speaks for you stops for confirmation.

Built for *Speed of Thought: AI Meetup* (WeMakeDevs, Gurugram, 31 Oct 2026). Voice input via Wispr Flow.

---

## What works today

| Task | Status | Notes |
|---|---|---|
| WhatsApp: open named chat, type, send | ✅ live on Pixel 10 | Accessibility tree is fully labelled (`id=entry`, `Send`, contact names) — tree-only works |
| Blinkit: search item, add to cart, open checkout | ✅ live, stops before payment | Product cards / ADD buttons are **unlabelled** in the tree — needs screenshots (vision) |
| YouTube: open and play first video | ✅ worked in July spike | |
| Fully autonomous laptop loop (`laptop/pilot.py`) | 🟡 written, snapshot tested | Needs the worker device token in the Keychain to run end to end |
| On-phone floating overlay app (`:app`) | 🟡 builds, unit-tested | Not yet acceptance-tested on device |

## How it works

```
 You speak (Wispr Flow → text)
      │
      ▼
 laptop/pilot.py  ── loop, max 20 steps ─────────────────────────────┐
   1. adb uiautomator dump  → numbered UI tree  "[12] Button \"Send\""│
   2. POST tree + task + history → Cloudflare Worker /v1/next-action  │
   3. Worker → OpenAI (gpt-4.1-mini, strict JSON schema) → ONE action │
   4. adb input tap / text / swipe / keyevent                         │
   5. repeat until task_complete ─────────────────────────────────────┘
```

**Action contract** (the only things the agent can do): `open_app`, `tap_element(index)`, `type_text(index, text)`,
`scroll(up|down)`, `press_back`, `press_home`, `wait(ms)`, `task_complete(summary)`.
Element indexes are only valid for the snapshot they came from; every step takes a fresh snapshot.

**Two runtimes, same brain:**
- **Laptop driver** (`laptop/`) — phone over wireless ADB. Fastest to demo and debug.
- **On-phone app** (`app/`) — `AccessibilityService` + floating push-to-talk bubble. No laptop, no ADB at runtime.
  This is the product direction.

## Repo layout

```
core/       Pure Kotlin agent loop: Orchestrator, ActionPolicy, TreeSerializer, LlmClient. JVM unit tests.
app/        Android app: AccessibilityDeviceController, OverlayService (bubble + STOP), VoiceController
            (SpeechRecognizer), SensitiveContentPolicy, LocalActionSafety, setup/permissions screen.
worker/     Cloudflare Worker (TypeScript): POST /v1/next-action, bearer auth, rate limit (30/min),
            Durable Object daily cap (300/day), privacy filter, no logging of request data.
laptop/     pilot.py — the ADB-driven loop used for the live demo.
spike/      July viability spike: treedump.py, drive.py (manual adb driver), sample UI dumps.
docs/superpowers/specs, plans/   Design docs and implementation plans (read the 2026-10-02 and 2026-10-03 ones).
```

## Setup

### Prerequisites
macOS/Linux, `adb` (Android platform-tools), Python 3.10+, JDK 21, Android SDK, Node 20+ (for the worker).

### 1. Connect the phone (wireless ADB)
1. Phone: Settings → About phone → tap **Build number** 7× → Developer options.
2. Developer options → **Wireless debugging** ON → **Pair device with pairing code**.
3. Laptop (same Wi-Fi):
   ```sh
   adb pair <ip>:<pairing-port> <6-digit-code>
   adb mdns services                  # shows _adb-tls-connect with the connect port
   adb connect <ip>:<connect-port>
   export ANDROID_SERIAL=<ip>:<connect-port>
   ```
4. Keep the screen awake while plugged in: `adb shell svc power stayon true`.

### 2. Backend token (never commit it)
The worker holds `OPENAI_API_KEY` and `PHONEPILOT_DEVICE_TOKEN` as **Cloudflare secrets**. To run your own:
```sh
cd worker && npm install
npx wrangler login
npx wrangler secret put PHONEPILOT_DEVICE_TOKEN
npx wrangler secret put OPENAI_API_KEY
npx wrangler deploy
```
Store the device token locally in the macOS Keychain (pilot.py reads it from there, never prints it):
```sh
security add-generic-password -a phonepilot -s phonepilot-device-token -w
export PHONEPILOT_WORKER_URL=https://<your-worker>.workers.dev/v1/next-action   # if not using the default
```

### 3. Run
```sh
python3 laptop/pilot.py                                   # interactive prompt — dictate with Wispr Flow
python3 laptop/pilot.py "open WhatsApp and say hi to Vaishnav"
```

### Hosted mode (web app → cloud → phone)
The worker also serves a web app at `/` (passcode-protected, mic button, live step log, Stop, Clear all).
Tasks go into a `TaskInbox` Durable Object; the phone host pulls them — it only makes outbound calls.
```sh
npx wrangler secret put PHONEPILOT_WEB_PASSCODE     # once, in worker/
python3 laptop/pilot.py --host                      # next to the phone
```
Routes: `POST /v1/tasks`, `GET /v1/tasks/:id`, `POST /v1/tasks/:id/cancel`, `POST /v1/tasks/clear` (web, `x-passcode`);
`POST /v1/host/next`, `POST /v1/host/tasks/:id/events` (host, bearer device token). Queued tasks expire after 10 min.

### Working on the web UI locally (no phone, no OpenAI key)
The page is the `PAGE` string at the bottom of `worker/src/tasks.ts`.
```sh
cd worker && npm install
printf 'PHONEPILOT_WEB_PASSCODE=dev\nPHONEPILOT_DEVICE_TOKEN=dev-token\nOPENAI_API_KEY=not-needed\n' > .dev.vars   # gitignored
npx wrangler dev                                    # http://localhost:8787, passcode "dev"
python3 ../laptop/fake_host.py                      # second terminal: fakes a phone run
npm test
```

### 4. Build / test the Android app
```sh
export ANDROID_HOME=<sdk path>   # e.g. /opt/homebrew/share/android-commandlinetools
./gradlew :core:test :app:testDebugUnitTest :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
cd worker && npm test
```

## Safety rules (non-negotiable)

- **No secrets in the repo or the APK.** API keys live only as worker secrets; device token in Keychain / Android Keystore.
- **Never automate payment, OTP, password, CVV, or banking fields.** The worker and the phone both block them.
- **Send-like taps** only when the task names the recipient *and* that recipient is visible on screen.
- **Credentials never leave the user's phone.** We run inside sessions the user is already logged into; we do not
  collect logins or run user accounts on our own devices.
- **Always interruptible.** Ctrl-C on the laptop; STOP on the overlay.

## Known gaps

- Blinkit (and many shopping apps) expose unlabelled `View ""` nodes — tree-only agent can't tell which ADD belongs
  to which product. Needs a screenshot/vision step.
- A back-press may only close the keyboard; the agent must re-check which screen it's on before acting.
- Wireless ADB port changes on every reconnect; `adb tcpip` mode resets on reboot.
- Five files in the worktree (worker-failure handling, overlay state) are tested locally but not yet committed.

## Roadmap / open work — pick one

1. **Skills (task replay)** — save a solved task as a parameterised recipe (`blinkit_add_to_cart {item}`), replay it
   with text/id selectors and per-step `expect` checks, fall back to the LLM only when a check fails.
   Route requests to skills with a small local quantized model (Ollama `gemma3:270m`) → zero cloud tokens on repeats.
2. **Vision fallback** — when the tree is thin, send a downscaled screenshot so the model can pick the element.
3. **Remote tasks** — Worker `POST /v1/tasks` → per-device Durable Object inbox → phone receives via WebSocket or
   FCM push → runs the loop locally → streams status back. Task TTLs and nonces so stale/replayed tasks never run.
4. **On-phone acceptance** — install the overlay app, run "open WhatsApp and find Shikhar" + send-confirmation flow.
5. **Local speech-to-text** — on-device/quantized Whisper for voice without a cloud STT.

## Contributing

- Branch from `main`, open a PR. Keep changes small; `core/` must stay pure Kotlin with tests.
- Don't commit UI dumps from your own phone that contain personal chats, contacts, or addresses.
- Test on a real device before marking a task ✅ in the table above.
