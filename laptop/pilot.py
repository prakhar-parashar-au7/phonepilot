#!/usr/bin/env python3
"""PhonePilot laptop driver: say a task, watch the phone do it.

Loop: adb screen dump -> numbered UI tree -> worker picks ONE action -> adb executes -> repeat.

    python3 laptop/pilot.py                      # interactive: dictate tasks (Wispr Flow) at the prompt
    python3 laptop/pilot.py "open YouTube and play the first video"
    python3 laptop/pilot.py --host               # pull tasks from the hosted web app and run them

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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import skills as skills_mod  # noqa: E402
from skills import SKILLS  # noqa: E402

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


def resolve_serial():
    """Pin ANDROID_SERIAL to the phone's current wireless-debugging address (port changes on reconnect)."""
    if os.environ.get("ANDROID_SERIAL"):
        return
    out = subprocess.run(["adb", "devices"], capture_output=True, text=True).stdout
    ips = [l.split()[0] for l in out.splitlines()[1:] if l.endswith("device") and re.match(r"\d+\.\d+\.\d+\.\d+:\d+", l)]
    if ips:
        os.environ["ANDROID_SERIAL"] = ips[0]


def adb(*args, timeout=20):
    return subprocess.run(["adb", *args], capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)


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


def phone_locked():
    """True if the screen is off or the keyguard is up. Wakes the screen as a side effect."""
    power = adb("shell", "dumpsys", "power").stdout
    if "mWakefulness=Awake" not in power:
        adb("shell", "input", "keyevent", "224")  # WAKEUP
        time.sleep(0.8)
    win = adb("shell", "dumpsys", "window").stdout
    return "isKeyguardShowing=true" in win or "mDreamingLockscreen=true" in win


SEND_LABEL = re.compile(r'"(Send|Send message)"', re.I)


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
        "Authorization": f"Bearer {tok}", "Content-Type": "application/json",
        "User-Agent": "PhonePilot-Host/0.1"})
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


def label_of(tree, index):
    return next((l for l in tree.splitlines() if l.startswith(f"[{index}] ")), "")


def step_text(step, a, tree, package, ok, result):
    t = a["type"]
    if "index" in a:
        line = next((l for l in tree.splitlines() if l.startswith(f"[{a['index']}] ")), "")
        m = re.search(r'"([^"]+)"', line)
        target = f' "{m.group(1)[:50]}"' if m and m.group(1) else ""
        verb = {"tap_element": "Tapped", "type_text": f'Typed "{a.get("text", "")[:40]}" into'}[t]
        text = f"{verb}{target or ' element ' + str(a['index'])}"
    elif t == "open_app":
        text = f"Opened {a['packageName']}"
    else:
        text = result[:1].upper() + result[1:]
    return (f"{step}. {text}" + ("" if ok else f" — failed: {result}"))[:300]


def host_call(path, tok, body=None):
    base = WORKER_URL.rsplit("/v1/", 1)[0]
    req = urllib.request.Request(base + path, data=json.dumps(body or {}).encode(), method="POST", headers={
        "Authorization": f"Bearer {tok}", "Content-Type": "application/json", "User-Agent": "PhonePilot-Host/0.1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


class SkillCtx:
    def __init__(self, tok, report, wait_answer):
        self.tok, self.report, self._wait = tok, report, wait_answer
        self.snapshot, self.adb = snapshot, adb

    def ask(self, q):
        if self._wait is None:
            return input(f"{C['y']}🙋 {q}\n   your answer › {C['x']}").strip()
        if self.report("ask", q[:300], "waiting"):
            raise skills_mod.Stop("cancelled")
        return self._wait()

    def llm_loop(self, sub_task, approve_send=None):
        # Sub-loop: its done/failed must not finish the parent task.
        def sub_report(kind, text, status=None):
            if status in ("done", "failed"):
                kind, status = ("step" if kind == "done" else kind), None
            return self.report(kind, text, status)
        return run(sub_task, self.tok, sub_report, self._wait, approve_send=approve_send)


SKILL_SCOPE = {
    "blinkit": "Use ONLY the Blinkit app (package com.grofers.customerapp); never open any other app. "
               "Search for the item, add it to the cart, open the cart, and stop before payment. Task: ",
    "whatsapp_triage": "Use ONLY WhatsApp (package com.whatsapp); never open any other app. Never send in group chats. Task: ",
}


def skill_task(skill, task):
    """The LLM fallback for a skill stays inside that skill's app."""
    return SKILL_SCOPE.get(skill or "", "") + task


def run_skill(skill, task, tok, report, wait_answer=None):
    """True if the skill finished the task (or stopped cleanly); False to fall back to the LLM loop."""
    ctx = SkillCtx(tok, report, wait_answer)
    if phone_locked():
        report("error", "Phone is locked — unlock it and try again", "failed")
        return True
    try:
        return skill(task, ctx)
    except skills_mod.Stop:
        report("error", "Stopped", "failed")
        return True


def host(tok):
    print(f"{C['b']}PhonePilot host{C['x']} — pulling tasks from {WORKER_URL.rsplit('/v1/', 1)[0]}  (Ctrl-C to quit)")
    while True:
        try:
            t = host_call("/v1/host/next", tok).get("task")
        except Exception as e:
            print(f"{C['r']}inbox error: {e}{C['x']}"); time.sleep(3); continue
        if not t:
            time.sleep(1.5); continue

        def report(kind, text, status=None, _id=t["id"]):
            try:
                body = {"kind": kind, "text": text}
                if status:
                    body["status"] = status
                return bool(host_call(f"/v1/host/tasks/{_id}/events", tok, body).get("cancelled"))
            except urllib.error.HTTPError as e:
                print(f"{C['r']}report {kind} failed: HTTP {e.code} {e.read().decode()[:120]}{C['x']}")
                return e.code == 404  # task was cleared from the web -> stop
            except Exception as e:
                print(f"{C['r']}report {kind} failed: {e}{C['x']}")
                return False

        def wait_answer(_id=t["id"], timeout=300):
            end = time.time() + timeout
            while time.time() < end:
                try:
                    r = host_call(f"/v1/host/tasks/{_id}/answer", tok)
                except urllib.error.HTTPError as e:
                    print(f"{C['r']}answer poll failed: HTTP {e.code}{C['x']}")
                    return None  # task cleared
                if r.get("status") not in ("waiting", "running"):
                    print(f"{C['dim']}task is now {r.get('status')}{C['x']}")
                if r.get("answer"):
                    return r["answer"]
                if r.get("status") not in ("waiting", "running"):
                    return None  # cancelled / expired
                time.sleep(1.2)
            return None

        skill = SKILLS.get(t.get("skill") or "")
        try:
            if skill:
                print(f"\n{C['b']}🧩 skill {t['skill']}: {t['task']}{C['x']}")
                if run_skill(skill, t["task"], tok, report, wait_answer):
                    continue
                report("info", "Skill couldn't follow the screen — handing over to the general agent")
            run(skill_task(t.get("skill"), t["task"]), tok, report, wait_answer,
                approve_send="this chat" if t.get("skill") == "whatsapp_triage" else None)
        except Exception as e:
            print(f"{C['r']}error: {e}{C['x']}")
            report("error", f"Error: {e}"[:300], "failed")


def run(task, tok, report=lambda kind, text, status=None: False, wait_answer=None, approve_send=None):
    """report() posts progress (returns True if the user cancelled).
    approve_send=<contact>: show any drafted message to the user and send only if they approve.
    Returns "sent", "done", or "stopped"."""
    print(f"\n{C['b']}🎯 {task}{C['x']}")
    history, t0, fails = [], time.time(), 0

    def ask(q):
        if wait_answer is None:
            return input(f"{C['y']}🙋 {q}\n   your answer › {C['x']}").strip()
        if report("ask", q[:300], "waiting"):
            return None
        return wait_answer()
    for step in range(1, MAX_STEPS + 1):
        if phone_locked():
            print(f"{C['r']}🔒 Phone is locked — unlock it and retry{C['x']}")
            report("error", "Phone is locked — unlock it and try again", "failed")
            return "stopped"
        package, tree, centers = snapshot()
        a = ask_worker(task + APP_HINT, package, tree, history, tok)
        if a["type"] == "task_complete":
            print(f"{C['g']}✅ Done in {step - 1} steps, {time.time() - t0:.0f}s: {a['summary']}{C['x']}")
            report("done", f"Done in {step - 1} steps, {time.time() - t0:.0f}s — {a['summary']}"[:300], "done")
            return "done"
        if a["type"] == "ask_user":
            q = a.get("question", "The agent needs more information")
            print(f"{C['y']}🙋 {q}{C['x']}")
            answer = ask(q)
            if not answer:
                print(f"{C['r']}⏹ No answer — stopped{C['x']}")
                report("error", "No answer received — stopped", "failed")
                return "stopped"
            print(f"{C['b']}   ↳ {answer}{C['x']}")
            history.append({"action": f"ask_user: {q}"[:300], "result": f"User replied: {answer}"[:300], "success": True})
            continue
        if approve_send and a["type"] == "type_text" and "id=entry" in label_of(tree, a["index"]):
            ans = ask(f'Reply to {approve_send}: "{a["text"]}" — send it? (yes / no / or type a different reply)')
            if not ans or ans.strip().lower() in ("no", "n", "skip", "don't", "dont"):
                report("step", f"Skipped reply to {approve_send}")
                return "stopped"
            if ans.strip().lower() not in ("yes", "y", "ok", "send", "haan", "ha"):
                a = {**a, "text": ans.strip()}
        ok, result = execute(a, centers)
        label = ""
        if "index" in a:
            line = next((l for l in tree.splitlines() if l.startswith(f"[{a['index']}] ")), "")
            label = f" {C['dim']}{line[:70]}{C['x']}"
        print(f"{C['c']}{step:>2}.{C['x']} {a['type']}{label} {C['dim']}({package}){C['x']}" + ("" if ok else f" {C['r']}✗ {result}{C['x']}"))
        history.append({"action": describe(a)[:300], "result": result[:300], "success": ok})
        if report("step" if ok else "error", step_text(step, a, tree, package, ok, result)):
            print(f"{C['r']}⏹ Stopped from the web{C['x']}")
            return "stopped"
        # Guard: a message is sent at most once per task — stop right after a successful Send tap.
        if ok and a["type"] == "tap_element" and SEND_LABEL.search(label_of(tree, a["index"])):
            time.sleep(1)
            print(f"{C['g']}✅ Sent — stopping after one send ({time.time() - t0:.0f}s){C['x']}")
            report("done", f"Message sent in {step} steps, {time.time() - t0:.0f}s", "done")
            return "sent"
        # Guard: three failed actions in a row means we're lost — stop instead of wandering.
        fails = 0 if ok else fails + 1
        if fails >= 3:
            print(f"{C['r']}⏹ Stuck — 3 failed actions in a row{C['x']}")
            report("error", "Stuck after 3 failed actions — stopped safely", "failed")
            return "stopped"
        time.sleep(1.2 if a["type"] in ("open_app", "tap_element") else 0.6)
    print(f"{C['r']}⏹ Step cap reached{C['x']}")
    report("error", "Step cap reached", "failed")
    return "stopped"


def main():
    tok = token()
    resolve_serial()
    print(f"{C['dim']}device: {os.environ.get('ANDROID_SERIAL', 'default')}{C['x']}")
    if sys.argv[1:2] == ["--host"]:
        host(tok)
        return
    if sys.argv[1:2] == ["--skill"] and len(sys.argv) > 3:
        def say(kind, text, status=None):
            print(f"  {kind}: {text}")
            return False
        if not run_skill(SKILLS[sys.argv[2]], " ".join(sys.argv[3:]), tok, say):
            run(skill_task(sys.argv[2], " ".join(sys.argv[3:])), tok)
        return
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
