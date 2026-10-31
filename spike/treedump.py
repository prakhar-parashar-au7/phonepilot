#!/usr/bin/env python3
"""PhonePilot spike: dump and analyze an app's accessibility/view tree over adb.

Goal: de-risk "is the UI element tree rich enough to drive this app text-only?"
WITHOUT building the app. Uses `uiautomator dump`, which exposes the same node
data our AccessibilityService would see.

Usage:
    python3 treedump.py youtube --find Share Search
    python3 treedump.py whatsapp --find Send "Search"

Open the target screen on the phone first, then run. Saves the raw XML under
spike/dumps/ and prints a verdict on tree-only viability.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

DUMPS = Path(__file__).parent / "dumps"
ADB_CANDIDATES = [
    "adb",
    "/opt/homebrew/bin/adb",
    "/usr/local/bin/adb",
    os.path.expanduser("~/Library/Android/sdk/platform-tools/adb"),
]


def find_adb() -> str:
    for c in ADB_CANDIDATES:
        path = shutil.which(c) if os.path.basename(c) == c else (c if os.path.exists(c) else None)
        if path:
            return path
    sys.exit("adb not found. Install with: brew install --cask android-platform-tools")


def run(adb: str, *args: str, **kw) -> subprocess.CompletedProcess:
    return subprocess.run([adb, *args], capture_output=True, text=True, **kw)


def check_device(adb: str) -> None:
    out = run(adb, "devices").stdout.strip().splitlines()[1:]
    devices = [l for l in out if l.strip() and "offline" not in l and "unauthorized" not in l]
    unauth = [l for l in out if "unauthorized" in l]
    if unauth:
        sys.exit("Device connected but UNAUTHORIZED. Accept the 'Allow USB debugging?' prompt on the phone, then retry.")
    if not devices:
        sys.exit("No authorized device. Plug in the phone, enable USB debugging, and accept the prompt.")
    print(f"Device: {devices[0].split()[0]}")


def capture(adb: str, label: str) -> str:
    """Run uiautomator dump on the device and return the XML text."""
    # Dump to device, then read it back. /dev/tty piping is flaky across shells.
    remote = "/sdcard/window_dump.xml"
    res = run(adb, "shell", "uiautomator", "dump", remote)
    if "ERROR" in (res.stdout + res.stderr) or res.returncode != 0:
        sys.exit(f"uiautomator dump failed (often FLAG_SECURE screen or busy UI):\n{res.stdout}{res.stderr}")
    xml = run(adb, "shell", "cat", remote).stdout
    DUMPS.mkdir(exist_ok=True)
    n = len(list(DUMPS.glob(f"{label}-*.xml")))
    out_file = DUMPS / f"{label}-{n}.xml"
    out_file.write_text(xml)
    print(f"Saved raw tree -> {out_file.relative_to(Path(__file__).parent.parent)}")
    return xml


def foreground_package(adb: str) -> str:
    out = run(adb, "shell", "dumpsys", "activity", "activity").stdout
    m = re.search(r"mResumedActivity.*?\s(\S+)/", out) or re.search(r"topResumedActivity.*?\s(\S+)/", out)
    return m.group(1) if m else "(unknown)"


def analyze(xml: str, find_terms: list[str]) -> None:
    nodes = list(ET.fromstring(xml).iter("node"))
    total = len(nodes)

    def has(n, attr):
        return bool((n.get(attr) or "").strip())

    with_text = [n for n in nodes if has(n, "text")]
    with_desc = [n for n in nodes if has(n, "content-desc")]
    clickable = [n for n in nodes if n.get("clickable") == "true"]
    editable = [n for n in nodes if "EditText" in (n.get("class") or "") or n.get("password") == "true"]
    scrollable = [n for n in nodes if n.get("scrollable") == "true"]
    # The gold metric: clickable elements that ALSO carry a label.
    labelled_clickable = [n for n in clickable if has(n, "text") or has(n, "content-desc")]

    def label(n):
        return (n.get("text") or n.get("content-desc") or "").strip()

    print("\n" + "=" * 60)
    print(f"  TREE ANALYSIS  ({total} nodes)")
    print("=" * 60)
    print(f"  with text label        : {len(with_text)}")
    print(f"  with content-desc      : {len(with_desc)}")
    print(f"  clickable              : {len(clickable)}")
    print(f"  clickable + labelled   : {len(labelled_clickable)}   <- drives tree-only taps")
    print(f"  editable (text fields) : {len(editable)}")
    print(f"  scrollable             : {len(scrollable)}")

    print("\n  Labelled, tappable elements (first 30):")
    for n in labelled_clickable[:30]:
        print(f"    - {label(n)!r}  [{n.get('class','').split('.')[-1]}]")
    if len(labelled_clickable) > 30:
        print(f"    ... and {len(labelled_clickable) - 30} more")

    if find_terms:
        print("\n  Looking for key actions:")
        all_labels = [label(n) for n in nodes if label(n)]
        for term in find_terms:
            hits = [l for l in all_labels if term.lower() in l.lower()]
            mark = "FOUND" if hits else "MISSING"
            extra = f" -> {hits[:3]}" if hits else ""
            print(f"    [{mark:7}] {term}{extra}")

    # Verdict heuristic.
    ratio = len(labelled_clickable) / max(len(clickable), 1)
    print("\n  VERDICT:")
    if len(labelled_clickable) >= 5 and ratio >= 0.5:
        print("    ✅ Tree-only looks VIABLE — plenty of labelled, tappable elements.")
    elif len(labelled_clickable) >= 3:
        print("    🟡 Tree-only PARTIAL — some labels present; will likely need vision for some screens.")
    else:
        print("    ❌ Tree is THIN — this screen will need the screenshot+vision path.")
    print("=" * 60)


def main():
    ap = argparse.ArgumentParser(description="Dump & analyze an app's accessibility tree over adb.")
    ap.add_argument("label", help="name for this capture, e.g. youtube / whatsapp")
    ap.add_argument("--find", nargs="*", default=[], help="key action labels to check for, e.g. Share Send Search")
    args = ap.parse_args()

    adb = find_adb()
    check_device(adb)
    print(f"Foreground app: {foreground_package(adb)}")
    xml = capture(adb, args.label)
    analyze(xml, args.find)


if __name__ == "__main__":
    main()
