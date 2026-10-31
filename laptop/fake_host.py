#!/usr/bin/env python3
"""Fake phone host for UI work — no phone, no OpenAI.

Claims tasks from a worker (local `wrangler dev` by default) and posts scripted steps,
so the web page shows a realistic run.

    python3 laptop/fake_host.py                         # http://localhost:8787, token "dev-token"
    python3 laptop/fake_host.py http://localhost:8787 my-token
"""
import json
import sys
import time
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787"
TOKEN = sys.argv[2] if len(sys.argv) > 2 else "dev-token"
STEPS = ["1. Opened com.whatsapp", '2. Tapped "vaishnav"', '3. Typed "hi" into "Message"', '4. Tapped "Send"']


def post(path, body=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body or {}).encode(), method="POST", headers={
        "Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json", "User-Agent": "PhonePilot-FakeHost/0.1"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


print(f"fake host polling {BASE}")
while True:
    try:
        task = post("/v1/host/next").get("task")
    except Exception as e:
        print("poll error:", e); time.sleep(2); continue
    if not task:
        time.sleep(1); continue
    print("running:", task["task"])
    try:
        stopped = False
        for s in STEPS:
            time.sleep(1.2)
            if post(f"/v1/host/tasks/{task['id']}/events", {"kind": "step", "text": s}).get("cancelled"):
                stopped = True; break
        if not stopped:
            post(f"/v1/host/tasks/{task['id']}/events", {"kind": "done", "text": "Message sent in 4 steps, 6s", "status": "done"})
    except urllib.error.HTTPError as e:
        print("task gone:", e.code)
