"""App skills: deterministic recipes that replace the LLM loop for known flows.

A skill drives the phone with text/id selectors on fresh screen dumps (never saved coordinates),
checks the expected screen after every step, and asks the user instead of guessing.
If a step's check fails, the caller falls back to the general LLM loop.

Each skill: fn(task, ctx) -> True when finished (success or a clean stop), False to fall back.
ctx: snapshot(), adb(...), report(kind, text, status=None) -> cancelled?, ask(question) -> answer|None,
     llm_loop(task) -> runs the general agent for a sub-task.
"""
import re
import time

BLINKIT = "com.grofers.customerapp"
WHATSAPP = "com.whatsapp"


class Stop(Exception):
    """User cancelled or the task can't continue safely."""


def idx(line):
    return int(line[1:line.index("]")])


def find(tree, pattern):
    """All lines matching a regex."""
    rx = re.compile(pattern)
    return [l for l in tree.splitlines() if rx.search(l)]


def launch(ctx, package):
    """Cold-start an app on a clean screen: close the notification shade first."""
    ctx.adb("shell", "cmd", "statusbar", "collapse")
    ctx.adb("shell", "am", "force-stop", package)
    ctx.adb("shell", "monkey", "-p", package, "-c", "android.intent.category.LAUNCHER", "1")


def wait_for(ctx, pattern, package=None, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        pkg, tree, centers = ctx.snapshot()
        if (package is None or pkg == package) and find(tree, pattern):
            return pkg, tree, centers
        time.sleep(0.8)
    return None


def tap(ctx, centers, line):
    x, y = centers[idx(line)]
    ctx.adb("shell", "input", "tap", str(x), str(y))


def step(ctx, text):
    if ctx.report("step", text[:300]):
        raise Stop("cancelled")


# ───────────────────────────── Blinkit: add item to cart → checkout ─────────────────────────────

FILLER = r"\b(open|go to|on|in|from|blinkit|and|please|order|add|buy|get|me|some|i want|want|the|my|cart|to|basket|checkout|go)\b"
CARD = re.compile(r'"(.+?) is available for ₹(\d+), ([^"]+)"')


def blinkit_item(task):
    item = re.sub(FILLER, " ", task.lower())
    item = re.sub(r"[^a-z ]", " ", item)  # drop quantities/punctuation
    return re.sub(r"\s+", " ", item).strip()


def blinkit(task, ctx):
    item = blinkit_item(task)
    if not item:
        item = (ctx.ask("What should I add to your Blinkit cart?") or "").strip()
        if not item:
            raise Stop("no item")
    t0 = time.time()

    # 1. Launch Blinkit on its home screen.
    launch(ctx, BLINKIT)
    got = wait_for(ctx, r'"Search ', BLINKIT, timeout=15)
    if not got:
        return False
    _, tree, centers = got
    step(ctx, "1. Opened Blinkit")

    # 2. Search.
    tap(ctx, centers, find(tree, r'"Search ')[0])
    got = wait_for(ctx, r"id=edittext .*editable", BLINKIT)
    if not got:
        return False
    ctx.adb("shell", "input", "text", item.replace(" ", "%s"))
    time.sleep(0.6)
    ctx.adb("shell", "input", "keyevent", "66")
    time.sleep(2.5)
    ctx.adb("shell", "input", "keyevent", "4")  # hide keyboard so all cards are on screen
    got = wait_for(ctx, r"is available for ₹", BLINKIT)
    if not got:
        return False
    _, tree, centers = got
    step(ctx, f'2. Searched "{item}"')

    # 3. Pick the product: cards whose name contains every word of the item, in Blinkit's order.
    cards = []
    for line in tree.splitlines():
        m = CARD.search(line)
        if m and "ViewGroup" in line:
            name, price, size = m.group(1), int(m.group(2)), m.group(3)
            if all(w.rstrip("s")[:6] in name.lower() for w in item.split()):
                cards.append((line, name, price, size))
    if not cards:
        ctx.report("error", f'No "{item}" found on Blinkit', "failed")
        return True
    adds = [l for l in find(tree, r'"ADD" id=tv_title')]

    def add_for(card_line):
        cx, cy = centers[idx(card_line)]
        near = [a for a in adds if abs(centers[idx(a)][0] - cx) < 160 and 0 < centers[idx(a)][1] - cy < 200]
        return near[0] if near else None

    options = [c for c in cards if add_for(c[0])][:3]
    if not options:
        ctx.report("done", f"{cards[0][1]} is already in your cart", "done")
        return True
    choice = options[0]
    if len(options) > 1:
        menu = " · ".join(f"{i + 1}) {n} {s} ₹{p}" for i, (_, n, p, s) in enumerate(options))
        ans = (ctx.ask(f"Which {item}? {menu}") or "").strip().lower()
        if not ans:
            raise Stop("no answer")
        pick = next((o for i, o in enumerate(options) if ans in (str(i + 1), f"{i + 1})") or ans in o[1].lower()), None)
        if pick is None:
            nums = re.findall(r"\d", ans)
            pick = options[int(nums[0]) - 1] if nums and 0 < int(nums[0]) <= len(options) else options[0]
        choice = pick
    line, name, price, size = choice

    # 4. Tap ADD; handle the pack-size sheet if it appears.
    tap(ctx, centers, add_for(line))
    time.sleep(1.8)
    _, tree, centers = ctx.snapshot()
    packs = find(tree, r'"Pack of 1')
    if packs:
        px, py = centers[idx(packs[0])]
        sheet_adds = sorted(find(tree, r'"ADD"'), key=lambda a: abs(centers[idx(a)][0] - px) + abs(centers[idx(a)][1] - py))
        if sheet_adds:
            tap(ctx, centers, sheet_adds[0])
            time.sleep(1.2)
        ctx.adb("shell", "input", "keyevent", "4")
        time.sleep(1)
    step(ctx, f"3. Added {name} ({size}, ₹{price})")

    # 5. Open the cart / checkout and stop before payment.
    got = wait_for(ctx, r'"View cart"', BLINKIT, timeout=6)
    if not got:
        return False
    _, tree, centers = got
    tap(ctx, centers, find(tree, r'"View cart"')[0])
    got = wait_for(ctx, r"(?i)checkout|address|proceed|bill", BLINKIT, timeout=8)
    step(ctx, "4. Opened checkout")
    ctx.report("done", f"Cart ready in {time.time() - t0:.0f}s: {name} {size} ₹{price}. Payment is yours — tap pay on the phone.", "done")
    return True


# ───────────────────────────── WhatsApp catch-up: reply to urgent personal chats ─────────────────

ROW_NAME = re.compile(r'"([^"]+)" id=conversations_row_contact_name')


def whatsapp_rows(tree):
    """Parse the chat list into rows: name, preview, unread, is_group, name_line."""
    lines = tree.splitlines()
    rows, cur = [], None
    for l in lines:
        if "id=contact_row_container" in l:
            if cur:
                rows.append(cur)
            cur = {"name": None, "preview": "", "unread": False, "group": False, "line": None}
        if cur is None:
            continue
        m = ROW_NAME.search(l)
        if m and cur["name"] is None:
            cur["name"], cur["line"] = m.group(1), l
        if "id=msg_from_tv" in l:  # "~Sender:" prefix only appears in group/community rows
            cur["group"] = True
        if "Community" in l or "id=parent_stack_photo" in l:
            cur["group"] = True
        if "id=single_msg_tv" in l:
            cur["preview"] = re.search(r'"([^"]*)"', l).group(1)
        if "unread message" in l:
            cur["unread"] = True
    if cur:
        rows.append(cur)
    return [r for r in rows if r["name"] and "(You)" not in r["name"]]


def whatsapp_triage(task, ctx):
    t0 = time.time()
    launch(ctx, WHATSAPP)
    got = wait_for(ctx, r"id=conversations_filter_debug_view_id_unread", WHATSAPP, timeout=12)
    if not got:
        return False
    _, tree, centers = got
    tap(ctx, centers, find(tree, r"id=conversations_filter_debug_view_id_unread")[0])
    time.sleep(1.5)
    _, tree, centers = ctx.snapshot()
    rows = [r for r in whatsapp_rows(tree) if r["unread"]]
    personal = [r for r in rows if not r["group"]]
    skipped = len(rows) - len(personal)
    step(ctx, f"1. {len(rows)} unread chats — {len(personal)} personal, {skipped} groups skipped")
    if not personal:
        ctx.report("done", "No unread personal chats — nothing to reply to", "done")
        return True

    replied, n = [], 1
    for row in personal[:4]:
        # Re-open the Unread list each time (the list changes after reading a chat).
        _, tree, centers = ctx.snapshot()
        target = next((l for l in find(tree, r"id=conversations_row_contact_name") if f'"{row["name"]}"' in l), None)
        if not target:
            continue
        tap(ctx, centers, target)
        got = wait_for(ctx, r"id=conversation_contact_name", WHATSAPP, timeout=6)
        if not got:
            ctx.adb("shell", "input", "keyevent", "4"); continue
        _, tree, centers = got
        header = find(tree, r"id=conversation_contact_name")[0]
        if f'"{row["name"]}"' not in header:
            ctx.adb("shell", "input", "keyevent", "4"); continue
        n += 1
        step(ctx, f'{n}. Reading {row["name"]}')
        # The LLM decides urgency and drafts; the host gates the send behind the user's approval.
        sub = (f'You are in the WhatsApp chat with {row["name"]}. Read the latest messages on screen. '
               f'If they are urgent (time-sensitive, asking for help, a pressing question, an emergency), type one short, '
               f'friendly, appropriate reply into the Message box and tap Send. If not urgent, do nothing and return task_complete '
               f'with summary "not urgent: <5-word gist>". Never promise money, never share personal data, never reply in a group.')
        outcome = ctx.llm_loop(sub, approve_send=row["name"])
        if outcome == "sent":
            replied.append(row["name"])
        ctx.adb("shell", "input", "keyevent", "4")
        time.sleep(1)
    summary = (f"Replied to {', '.join(replied)}" if replied else "Nothing urgent — no replies sent") + \
              f" · {skipped} group chat(s) skipped · {time.time() - t0:.0f}s"
    ctx.report("done", summary[:300], "done")
    return True


SKILLS = {"blinkit": blinkit, "whatsapp_triage": whatsapp_triage}
