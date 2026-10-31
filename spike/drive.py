#!/usr/bin/env python3
"""PhonePilot spike: manual device driver over adb.

Acts as the 'hands' while a human (or Claude) is the 'brain' — the manual
dry-run of the agent loop. Perceive with `dump`, act with `tap`/`text`/`key`.

    python3 drive.py dump                 # list interactable elements + center coords
    python3 drive.py tap 540 1200         # tap a coordinate
    python3 drive.py taplabel "Search"    # tap the element whose label contains text
    python3 drive.py text "milk"          # type into the focused field
    python3 drive.py key 4                 # keyevent (4=BACK, 3=HOME, 66=ENTER)
    python3 drive.py open com.grofers.customerapp
"""
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

DUMPS = Path(__file__).parent / "dumps"
ADB = next((c for c in ["/opt/homebrew/bin/adb", "/usr/local/bin/adb", shutil.which("adb")]
            if c and os.path.exists(c)), "adb")


def sh(*args, **kw):
    return subprocess.run([ADB, *args], capture_output=True, text=True, **kw)


def center(bounds: str):
    m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds or "")
    if not m:
        return None
    x1, y1, x2, y2 = map(int, m.groups())
    return (x1 + x2) // 2, (y1 + y2) // 2


def dump(show_all=False):
    remote = "/sdcard/window_dump.xml"
    res = sh("shell", "uiautomator", "dump", remote)
    if res.returncode != 0 or "ERROR" in (res.stdout + res.stderr):
        sys.exit(f"dump failed: {res.stdout}{res.stderr}")
    xml = sh("shell", "cat", remote).stdout
    DUMPS.mkdir(exist_ok=True)
    (DUMPS / "live.xml").write_text(xml)
    nodes = list(ET.fromstring(xml).iter("node"))
    print(f"{'idx':>3}  {'center':>11}  {'C':1} {'E':1}  label")
    print("-" * 70)
    for i, n in enumerate(nodes):
        label = (n.get("text") or n.get("content-desc") or "").strip()
        clickable = n.get("clickable") == "true"
        editable = "EditText" in (n.get("class") or "")
        if not (show_all or label or clickable or editable):
            continue
        c = center(n.get("bounds", ""))
        cc = f"{c[0]},{c[1]}" if c else "?"
        print(f"{i:>3}  {cc:>11}  {'x' if clickable else ' '} {'e' if editable else ' '}  {label[:60]!r}")


def taplabel(term):
    xml = (DUMPS / "live.xml").read_text()
    for n in ET.fromstring(xml).iter("node"):
        label = (n.get("text") or n.get("content-desc") or "").strip()
        if term.lower() in label.lower():
            c = center(n.get("bounds", ""))
            if c:
                print(f"tap {c} -> {label!r}")
                sh("shell", "input", "tap", str(c[0]), str(c[1]))
                return
    sys.exit(f"no element matching {term!r} (run dump first)")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd = sys.argv[1]
    if cmd == "dump":
        dump("--all" in sys.argv)
    elif cmd == "tap":
        sh("shell", "input", "tap", sys.argv[2], sys.argv[3])
        print(f"tapped {sys.argv[2]},{sys.argv[3]}")
    elif cmd == "taplabel":
        taplabel(sys.argv[2])
    elif cmd == "text":
        sh("shell", "input", "text", sys.argv[2].replace(" ", "%s"))
        print(f"typed {sys.argv[2]!r}")
    elif cmd == "key":
        sh("shell", "input", "keyevent", sys.argv[2])
        print(f"keyevent {sys.argv[2]}")
    elif cmd == "open":
        act = sh("shell", "cmd", "package", "resolve-activity", "--brief", sys.argv[2]).stdout.strip().splitlines()[-1]
        sh("shell", "am", "start", "-n", act)
        print(f"opened {act}")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
