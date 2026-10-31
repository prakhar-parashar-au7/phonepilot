# Spike: Accessibility-tree viability check

**Question this answers:** Is the on-screen UI element tree of YouTube and
WhatsApp rich enough (labelled, clickable nodes) to drive them **text-only**,
before we commit to building the full app? This is risk #1 from the design.

No app is built or installed. We use `adb shell uiautomator dump`, which exposes
the same accessibility node data our `AccessibilityService` would read.

## One-time device setup (you must do this physically)

1. On the phone: **Settings → About phone → tap "Build number" 7 times** to
   unlock Developer Options.
2. **Settings → System → Developer options → enable "USB debugging".**
3. Plug the phone into the Mac with a USB cable.
4. A **"Allow USB debugging?"** prompt appears on the phone — tap **Allow**.
5. Verify the Mac sees it:
   ```
   adb devices
   ```
   You should see your device id followed by `device` (not `unauthorized`).

## Running the check

Open the target screen on the phone *first*, then run the matching command.

```bash
# 1. Open a YouTube video on the phone, then:
python3 spike/treedump.py youtube --find Share Search Subscribe

# 2. Open a WhatsApp chat on the phone, then:
python3 spike/treedump.py whatsapp --find Send Search "Type a message"
```

Each run prints a summary (how many labelled, tappable elements exist), checks
for the key actions we'll need, gives a viability verdict, and saves the raw XML
under `spike/dumps/` so we can inspect it together.

## How to read the result

- **✅ viable** — tree-only will drive this app; cheapest path confirmed.
- **🟡 partial** — works for most screens, vision needed for some.
- **❌ thin** — this app/screen needs the screenshot+vision path from the start.
