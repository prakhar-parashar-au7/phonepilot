#!/usr/bin/env python3
"""PhonePilot laptop driver: say a task, watch the phone do it.

Loop: adb screen dump -> numbered UI tree -> worker picks ONE action -> adb executes -> repeat.

    python3 laptop/pilot.py                      # interactive: dictate tasks (Wispr Flow) at the prompt
    python3 laptop/pilot.py "open YouTube and play the first video"

Env: ANDROID_SERIAL (adb device), PHONEPILOT_WORKER_URL (optional override).
Token is read from the macOS Keychain (service phonepilot-device-token); never printed.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

WORKER_URL = os.environ.get(
    "PHONEPILOT_WORKER_URL",
    "https://phonepilot-agent.prakhar24680.workers.dev/v1/next-action",
)
MAX_STEPS = 20
APP_HINT = (
    " [Apps: WhatsApp=com.whatsapp, YouTube=com.google.android.youtube, "
    "Blinkit=com.grofers.customerapp, Chrome=com.android.chrome, Maps=com.google.android.apps.maps]"
)

C = {"dim": "\033[2m", "b": "\033[1m", "g": "\033[32m", "y": "\033[33m", "r": "\033[31m", "c": "\033[36m", "x": "\033[0m"}


def adb(*args, timeout=20):
    return subprocess.run(["adb", *args], capture_output=True, text=True, timeout=timeout)


def token():
    res = subprocess.run(
        ["security", "find-generic-password", "-a", "phonepilot", "-s", "phonepilot-device-token", "-w"],
        capture_output=True, text=True,
    )
    if res.returncode != 0:
        sys.exit("Token not in Keychain. Run: security add-generic-password -a phonepilot -s phonepilot-device-token -w")
    return res.stdout.strip()


def bounds_center(b):
    m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", b or "")
    if not m:
        return None
    x1, y1, x2, y2 = map(int, m.groups())
    if x2 <= x1 or y2 <= y1:
        return None
    return (x1 + x2) // 2, (y1 + y2) // 2


def snapshot():
    """Return (package, serialized_tree, {index: (x, y)})."""
    xml = ""
    for _ in range(3):
        adb("shell", "uiautomator", "dump", "/sdcard/pp_dump.xml")
        xml = adb("shell", "cat", "/sdcard/pp_dump.xml").stdout
        if "<hierarchy" in xml:
            break
        time.sleep(0.7)
    if "<hierarchy" not in xml:
        raise RuntimeError("screen dump failed")
    root = ET.fromstring(xml[xml.index("<hierarchy"):])
    nodes = list(root.iter("node"))
    package = next((n.get("package") for n in nodes if n.get("package")), "unknown")
    lines, centers = [], {}
    for n in nodes:
        label = (n.get("text") or n.get("content-desc") or "").strip().replace("\n", " ")
        clickable = n.get("clickable") == "true" or n.get("long-clickable") == "true"
        editable = "EditText" in (n.get("class") or "")
        scrollable = n.get("scrollable") == "true"
        if not (label or clickable or editable):
            continue
        c = bounds_center(n.get("bounds"))
        if not c:
            continue
        i = len(centers)
        centers[i] = c
        cls = (n.get("class") or "").split(".")[-1]
        rid = (n.get("resource-id") or "").split("/")[-1]
        flags = ",".join(f for f, on in [("clickable", clickable), ("editable", editable), ("scrollable", scrollable)] if on)
        lines.append(f'[{i}] {cls} "{label[:80]}"' + (f" id={rid}" if rid else "") + (f" ({flags})" if flags else ""))
    return package, "\n".join(lines)[:49_000] or "(empty screen)", centers


def ask_worker(task, package, tree, history, tok):
    body = json.dumps({"task": task, "activePackage": package, "serializedUiTree": tree, "history": history[-25:]}).encode()
    req = urllib.request.Request(WORKER_URL, data=body, method="POST", headers={
        "Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return json.loads(r.read())["action"]
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"worker HTTP {e.code}: {e.read().decode()[:200]}")


def adb_text(s):
    out = []
    for ch in s:
        if ch == " ":
            out.append("%s")
        elif ch in "()<>|;&*\\~\"'`$?#!{}[]":
            out.append("\\" + ch)
        else:
            out.append(ch)
    return "".join(out)


def execute(a, centers):
    t = a["type"]
    if t == "open_app":
        r = adb("shell", "monkey", "-p", a["packageName"], "-c", "android.intent.category.LAUNCHER", "1")
        return ("No activities found" not in r.stdout + r.stderr), f"opened {a['packageName']}"
    if t in ("tap_element", "type_text"):
        c = centers.get(a["index"])
        if not c:
            return False, f"index {a['index']} not on screen"
        adb("shell", "input", "tap", str(c[0]), str(c[1]))
        if t == "tap_element":
            return True, f"tapped [{a['index']}]"
        time.sleep(0.5)
        adb("shell", "input", "text", adb_text(a["text"]))
        return True, f"typed into [{a['index']}]"
    if t == "scroll":
        y1, y2 = (1700, 700) if a["direction"] == "down" else (700, 1700)
        adb("shell", "input", "swipe", "540", str(y1), "540", str(y2), "300")
        return True, f"scrolled {a['direction']}"
    if t == "press_back":
        adb("shell", "input", "keyevent", "4"); return True, "pressed back"
    if t == "press_home":
        adb("shell", "input", "keyevent", "3"); return True, "pressed home"
    if t == "wait":
        time.sleep(a["milliseconds"] / 1000); return True, f"waited {a['milliseconds']}ms"
    return False, f"unsupported action {t}"


def describe(a):
    return json.dumps({k: v for k, v in a.items()}, ensure_ascii=False)


def run(task, tok):
    print(f"\n{C['b']}🎯 {task}{C['x']}")
    history, t0 = [], time.time()
    for step in range(1, MAX_STEPS + 1):
        package, tree, centers = snapshot()
        a = ask_worker(task + APP_HINT, package, tree, history, tok)
        if a["type"] == "task_complete":
            print(f"{C['g']}✅ Done in {step - 1} steps, {time.time() - t0:.0f}s: {a['summary']}{C['x']}")
            return
        if a["type"] == "ask_user":
            print(f"{C['y']}✋ {a.get('question')}{C['x']}")
            return
        ok, result = execute(a, centers)
        label = ""
        if "index" in a:
            line = next((l for l in tree.splitlines() if l.startswith(f"[{a['index']}] ")), "")
            label = f" {C['dim']}{line[:70]}{C['x']}"
        print(f"{C['c']}{step:>2}.{C['x']} {a['type']}{label} {C['dim']}({package}){C['x']}" + ("" if ok else f" {C['r']}✗ {result}{C['x']}"))
        history.append({"action": describe(a)[:300], "result": result[:300], "success": ok})
        time.sleep(1.2 if a["type"] in ("open_app", "tap_element") else 0.6)
    print(f"{C['r']}⏹ Step cap reached{C['x']}")


def main():
    tok = token()
    if len(sys.argv) > 1:
        run(" ".join(sys.argv[1:]), tok)
        return
    print(f"{C['b']}PhonePilot{C['x']} — dictate a task (Wispr Flow), Enter to run, Ctrl-C to quit.")
    while True:
        try:
            task = input(f"\n{C['b']}🎙  ›{C['x']} ").strip()
        except (EOFError, KeyboardInterrupt):
            print(); return
        if task:
            try:
                run(task, tok)
            except KeyboardInterrupt:
                print(f"\n{C['r']}⏹ Stopped{C['x']}")
            except Exception as e:
                print(f"{C['r']}error: {e}{C['x']}")


if __name__ == "__main__":
    main()
