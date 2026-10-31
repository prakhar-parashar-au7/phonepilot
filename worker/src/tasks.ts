/**
 * Hosted task inbox: website -> cloud queue -> phone host (pulls) -> status back to website.
 *
 * Web routes (x-passcode header = PHONEPILOT_WEB_PASSCODE):
 *   POST /v1/tasks              {task}        -> {id}
 *   GET  /v1/tasks/:id                        -> {task}
 *   POST /v1/tasks/:id/cancel                 -> {task}
 *   POST /v1/tasks/:id/answer  {answer}      -> {task}   (reply to the agent's question)
 *   POST /v1/tasks/clear                      -> {cleared}  (deletes every task; a running one stops)
 * Host routes (Bearer PHONEPILOT_DEVICE_TOKEN):
 *   POST /v1/host/next                        -> {task} | {task:null}
 *   POST /v1/host/tasks/:id/events {kind,text,status?} -> {cancelled}   kind "ask" + status "waiting" asks the user
 *   POST /v1/host/tasks/:id/answer            -> {status, answer|null}
 *
 * The phone host only ever connects outward; nothing on the internet can reach the phone.
 */

export type TaskStatus = "queued" | "running" | "waiting" | "done" | "failed" | "cancelled" | "expired";
export type TaskEvent = { at: number; kind: "info" | "step" | "done" | "error" | "ask" | "answer"; text: string };
export type Task = { id: string; task: string; skill: string | null; status: TaskStatus; createdAt: number; updatedAt: number; events: TaskEvent[]; question?: string | null; answer?: string | null };
export const SKILLS = ["blinkit", "whatsapp_triage"];

export interface KvStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  delete(keys: string[]): Promise<number>;
}

export const TASK_TTL_MS = 10 * 60 * 1000;
const MAX_EVENTS = 80;
const FINAL: TaskStatus[] = ["done", "failed", "cancelled", "expired"];

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function fail(status: number, code: string): Response {
  return json({ error: { code, message: code.replace(/_/g, " ") } }, status);
}

/** Durable Object: one inbox per phone. Serial execution makes claim() race-free. */
export class TaskInbox {
  constructor(private readonly state: { storage: KvStorage }, _env: unknown, private readonly now: () => number = Date.now) {}

  private async save(task: Task): Promise<Task> {
    task.updatedAt = this.now();
    await this.state.storage.put(`task:${task.id}`, task);
    return task;
  }

  async create(text: string, skill: string | null = null): Promise<Task> {
    const t = this.now();
    const task: Task = { id: `${t.toString(36)}-${crypto.randomUUID().slice(0, 8)}`, task: text, skill, status: "queued", createdAt: t, updatedAt: t, events: [] };
    task.events.push({ at: t, kind: "info", text: "Queued — waiting for the phone" });
    return this.save(task);
  }

  async get(id: string): Promise<Task | undefined> {
    const task = await this.state.storage.get<Task>(`task:${id}`);
    if (task && task.status === "queued" && this.now() - task.createdAt > TASK_TTL_MS) {
      task.status = "expired";
      task.events.push({ at: this.now(), kind: "error", text: "Expired before the phone picked it up" });
      await this.save(task);
    }
    return task;
  }

  async claim(): Promise<Task | null> {
    const all = [...(await this.state.storage.list<Task>({ prefix: "task:" })).values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const candidate of all) {
      if (candidate.status !== "queued") continue;
      const task = await this.get(candidate.id);
      if (task?.status !== "queued") continue;
      task.status = "running";
      task.events.push({ at: this.now(), kind: "info", text: "Phone picked up the task" });
      return this.save(task);
    }
    return null;
  }

  async event(id: string, kind: TaskEvent["kind"], text: string, status?: TaskStatus): Promise<{ cancelled: boolean } | null> {
    const task = await this.get(id);
    if (!task) return null;
    if (task.status === "cancelled") return { cancelled: true };
    if (FINAL.includes(task.status)) return { cancelled: false };
    if (task.events.length < MAX_EVENTS) task.events.push({ at: this.now(), kind, text });
    if (status && FINAL.includes(status)) task.status = status;
    if (status === "waiting" && kind === "ask") { task.status = "waiting"; task.question = text; task.answer = null; }
    await this.save(task);
    return { cancelled: false };
  }

  async answer(id: string, text: string): Promise<Task | undefined> {
    const task = await this.get(id);
    if (!task || task.status !== "waiting") return task;
    task.answer = text;
    task.question = null;
    task.status = "running";
    task.events.push({ at: this.now(), kind: "answer", text });
    return this.save(task);
  }

  /** Host side: has the user answered yet? Consumes the answer once. */
  async takeAnswer(id: string): Promise<{ status: TaskStatus; answer: string | null } | null> {
    const task = await this.get(id);
    if (!task) return null;
    const answer = task.answer ?? null;
    if (answer !== null) { task.answer = null; await this.save(task); }
    return { status: task.status, answer };
  }

  async cancel(id: string): Promise<Task | undefined> {
    const task = await this.get(id);
    if (!task || FINAL.includes(task.status)) return task;
    task.status = "cancelled";
    task.events.push({ at: this.now(), kind: "error", text: "Stopped by user" });
    return this.save(task);
  }

  async clear(): Promise<number> {
    const keys = [...(await this.state.storage.list<Task>({ prefix: "task:" })).keys()];
    for (let i = 0; i < keys.length; i += 128) await this.state.storage.delete(keys.slice(i, i + 128));
    return keys.length;
  }

  /** Internal RPC over fetch, matching the DailyLimitCounter style. */
  async fetch(request: Request): Promise<Response> {
    let body: Record<string, unknown> = {};
    try { body = (await request.json()) as Record<string, unknown>; } catch { /* empty */ }
    const op = new URL(request.url).pathname.slice(1);
    const id = typeof body.id === "string" ? body.id : "";
    if (op === "create") return json({ task: await this.create(String(body.task), typeof body.skill === "string" ? body.skill : null) });
    if (op === "answer") return json({ task: (await this.answer(id, String(body.answer))) ?? null });
    if (op === "take-answer") return json(await this.takeAnswer(id));
    if (op === "get") return json({ task: (await this.get(id)) ?? null });
    if (op === "claim") return json({ task: await this.claim() });
    if (op === "clear") return json({ cleared: await this.clear() });
    if (op === "cancel") return json({ task: (await this.cancel(id)) ?? null });
    if (op === "event") return json(await this.event(id, body.kind as TaskEvent["kind"], String(body.text), body.status as TaskStatus | undefined));
    return fail(404, "not_found");
  }
}

type Inbox = { fetch(request: Request): Promise<Response> };
export type TaskEnv = {
  PHONEPILOT_DEVICE_TOKEN: string;
  PHONEPILOT_WEB_PASSCODE?: string;
  TASK_INBOX?: { idFromName(name: string): unknown; get(id: unknown): Inbox };
  DEVICE_RATE_LIMIT: { limit(options: { key: string }): Promise<{ success: boolean }> };
};

function safeEqual(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const SENSITIVE = /\b(?:otp|one[ -]?time[ -]?password|password|cvv|pin|account number|card number|credential)\b/i;
const KINDS = ["info", "step", "done", "error", "ask"];
const ID = /^[a-z0-9]+-[a-f0-9]{8}$/;

async function call(env: TaskEnv, op: string, body: unknown = {}): Promise<Response> {
  const inbox = env.TASK_INBOX!.get(env.TASK_INBOX!.idFromName("default"));
  return inbox.fetch(new Request(`https://inbox/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}

/** Returns a Response for task routes, or null if the path isn't a task route. */
export async function handleTaskRoutes(request: Request, env: TaskEnv): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } });
  }
  const isWeb = pathname === "/v1/tasks" || pathname.startsWith("/v1/tasks/");
  const isHost = pathname.startsWith("/v1/host/");
  if (!isWeb && !isHost) return null;
  if (!env.TASK_INBOX) return fail(503, "inbox_unavailable");

  if (isWeb) {
    const pass = request.headers.get("x-passcode") ?? "";
    if (!env.PHONEPILOT_WEB_PASSCODE || !safeEqual(pass, env.PHONEPILOT_WEB_PASSCODE)) return fail(401, "unauthorized");
    if (request.method === "POST" && pathname === "/v1/tasks") {
      const limited = await env.DEVICE_RATE_LIMIT.limit({ key: "web" });
      if (!limited.success) return fail(429, "rate_limited");
      let body: unknown;
      try { body = await request.json(); } catch { return fail(400, "invalid_request"); }
      const task = typeof (body as { task?: unknown })?.task === "string" ? (body as { task: string }).task.trim() : "";
      if (task.length < 2 || task.length > 400) return fail(400, "invalid_request");
      if (SENSITIVE.test(task)) return fail(400, "sensitive_content_blocked");
      const rawSkill = (body as { skill?: unknown }).skill;
      const skill = rawSkill === undefined || rawSkill === null || rawSkill === "" ? null : String(rawSkill);
      if (skill !== null && !SKILLS.includes(skill)) return fail(400, "unknown_skill");
      const res = await call(env, "create", { task, skill });
      const created = ((await res.json()) as { task: Task }).task;
      return json({ id: created.id, task: created }, 201);
    }
    if (request.method === "POST" && pathname === "/v1/tasks/clear") return call(env, "clear");
    const m = pathname.match(/^\/v1\/tasks\/([^/]+)(\/cancel|\/answer)?$/);
    if (!m || !ID.test(m[1])) return fail(404, "not_found");
    if (request.method === "POST" && m[2] === "/answer") {
      let body: unknown;
      try { body = await request.json(); } catch { return fail(400, "invalid_request"); }
      const answer = typeof (body as { answer?: unknown })?.answer === "string" ? (body as { answer: string }).answer.trim() : "";
      if (answer.length < 1 || answer.length > 200) return fail(400, "invalid_request");
      if (SENSITIVE.test(answer)) return fail(400, "sensitive_content_blocked");
      const { task } = (await (await call(env, "answer", { id: m[1], answer })).json()) as { task: Task | null };
      return task ? json({ task }) : fail(404, "not_found");
    }
    if (request.method === "GET" && !m[2]) {
      const { task } = (await (await call(env, "get", { id: m[1] })).json()) as { task: Task | null };
      return task ? json({ task }) : fail(404, "not_found");
    }
    if (request.method === "POST" && m[2]) {
      const { task } = (await (await call(env, "cancel", { id: m[1] })).json()) as { task: Task | null };
      return task ? json({ task }) : fail(404, "not_found");
    }
    return fail(405, "method_not_allowed");
  }

  // Host routes
  const auth = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/);
  if (!auth || !safeEqual(auth[1], env.PHONEPILOT_DEVICE_TOKEN)) return fail(401, "unauthorized");
  if (request.method !== "POST") return fail(405, "method_not_allowed");
  if (pathname === "/v1/host/next") return call(env, "claim");
  const a = pathname.match(/^\/v1\/host\/tasks\/([^/]+)\/answer$/);
  if (a && ID.test(a[1])) {
    const result = await (await call(env, "take-answer", { id: a[1] })).json();
    return result ? json(result) : fail(404, "not_found");
  }
  const m = pathname.match(/^\/v1\/host\/tasks\/([^/]+)\/events$/);
  if (!m || !ID.test(m[1])) return fail(404, "not_found");
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { return fail(400, "invalid_request"); }
  const status = body.status;
  if (!KINDS.includes(String(body.kind)) || typeof body.text !== "string" || body.text.length < 1 || body.text.length > 300) return fail(400, "invalid_request");
  if (status !== undefined && !["done", "failed", "waiting"].includes(String(status))) return fail(400, "invalid_request");
  if (status === "waiting" && body.kind !== "ask") return fail(400, "invalid_request");
  const res = await call(env, "event", { id: m[1], kind: body.kind, text: body.text, status });
  const result = await res.json();
  return result ? json(result) : fail(404, "not_found");
}

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PhonePilot</title>
<style>
:root{--ink:#10213f;--muted:#60708a;--line:#e3e9f1;--blue:#2169f3;--pale:#edf4ff;--green:#18834c;--greenBg:#e8f8ef;--red:#c33a35;--redBg:#fdeeed;--bg:#f6f8fb;--white:#fff}
*{box-sizing:border-box;margin:0}
html{-webkit-text-size-adjust:100%}
body{font:16px/1.55 -apple-system,system-ui,'Segoe UI',sans-serif;background:var(--bg);color:var(--ink);min-height:100dvh}

/* ─── Shell ─── */
.shell{max-width:920px;margin:0 auto;min-height:100dvh;background:var(--white);border-left:1px solid var(--line);border-right:1px solid var(--line)}
.topbar{height:60px;background:var(--white);border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 28px}
.brand{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:750}
.brand-mark{display:grid;place-items:center;width:30px;height:30px;border-radius:10px;background:var(--blue);color:#fff;font-weight:800;font-size:15px}
.topbar-right{display:flex;align-items:center;gap:10px}
.pass-area{display:flex;align-items:center;gap:6px}
.pass-lbl{font-size:12px;color:var(--muted);white-space:nowrap}
input[type=password]{background:var(--bg);border:1px solid var(--line);border-radius:8px;color:var(--ink);padding:6px 10px;font:13px/1.4 inherit;width:110px}
input[type=password]:focus{outline:none;border-color:var(--blue)}

/* ─── Content ─── */
.content{padding:36px 32px 28px}
.hero{display:grid;grid-template-columns:minmax(240px,.85fr) minmax(320px,1.15fr);gap:28px;align-items:start}

/* ─── Left copy ─── */
.kicker{color:var(--blue);font-size:11px;font-weight:800;letter-spacing:.15em;margin-bottom:14px}
.hero-copy h2{font-size:38px;letter-spacing:-.04em;line-height:1.08;margin:0 0 14px;max-width:400px;font-weight:800}
.hero-copy p{font-size:15px;line-height:1.55;color:var(--muted);max-width:380px;margin-bottom:22px}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{border:1px solid var(--line);border-radius:999px;padding:7px 13px;background:var(--white);color:#42516a;font-size:13px;cursor:pointer;transition:border-color .15s,color .15s}
.chip:hover{border-color:var(--blue);color:var(--blue)}

/* ─── Right request card ─── */
.req-card{background:var(--white);border:1px solid var(--line);border-radius:16px;padding:22px;box-shadow:0 14px 35px rgba(29,53,87,.06)}
.req-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}
.req-head strong{font-size:16px}
.status-dot{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:650;color:var(--muted)}
.sdot{width:9px;height:9px;border-radius:50%;background:#a5b3c8}
.sdot.live{background:var(--green);animation:dotPulse 2s ease-in-out infinite}
@keyframes dotPulse{0%,100%{opacity:1}50%{opacity:.4}}

/* ─── Voice area ─── */
.voice-box{padding:18px;border-radius:14px;background:var(--pale);text-align:center;margin-bottom:16px}
.wave{height:52px;display:flex;align-items:center;justify-content:center;gap:4px;margin-bottom:14px}
.wave i{display:block;width:4px;border-radius:10px;background:#a3c4fd;transition:height .2s,background .2s}
.wave i:nth-child(1){height:12px}.wave i:nth-child(2){height:22px}.wave i:nth-child(3){height:32px;background:#78a9ff}
.wave i:nth-child(4){height:44px;background:var(--blue)}.wave i:nth-child(5){height:36px;background:#78a9ff}
.wave i:nth-child(6){height:50px;background:var(--blue)}.wave i:nth-child(7){height:38px;background:#78a9ff}
.wave i:nth-child(8){height:28px}.wave i:nth-child(9){height:16px}.wave i:nth-child(10){height:10px}
.wave i:nth-child(11){height:20px}.wave i:nth-child(12){height:42px;background:var(--blue)}
.wave i:nth-child(13){height:30px;background:#78a9ff}
.wave.active i{animation:waveBar .6s ease-in-out infinite alternate}
.wave.active i:nth-child(2n){animation-delay:.15s}
.wave.active i:nth-child(3n){animation-delay:.3s}
.wave.active i:nth-child(5n){animation-delay:.1s}
@keyframes waveBar{0%{height:8px;background:#a3c4fd}100%{height:50px;background:var(--blue)}}
#mic{border:0;width:100%;min-height:48px;border-radius:11px;background:var(--blue);color:#fff;font:700 15px/1 inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:background .15s}
#mic:hover{background:#1858df}
#mic.on{background:var(--red)}
#mic.on:hover{background:#a82e28}

/* ─── Transcript / textarea ─── */
textarea{width:100%;border:1px solid var(--line);border-radius:12px;padding:14px 15px;min-height:80px;font:inherit;color:var(--ink);background:var(--white);resize:vertical;transition:border-color .15s}
textarea:focus{outline:none;border-color:var(--blue)}
textarea::placeholder{color:#94a3b8}

/* ─── Action buttons ─── */
.actions{display:flex;gap:10px;margin-top:14px}
button{font:inherit;cursor:pointer}
#go{border:0;flex:1;min-height:44px;padding:0 16px;border-radius:10px;background:var(--ink);color:#fff;font-weight:700;font-size:15px;transition:opacity .12s}
#go:disabled{opacity:.4;cursor:not-allowed}
#stop{border:0;flex:1;min-height:44px;padding:0 16px;border-radius:10px;background:var(--white);border:1px solid #efb0ac;color:var(--red);font-weight:700;font-size:15px;display:none}
#stop:hover{background:var(--redBg)}
#clear{background:var(--white);border:1px solid var(--line);color:var(--muted);border-radius:10px;padding:0 14px;min-height:44px;font-weight:600;font-size:14px;white-space:nowrap}
#clear:hover{border-color:#b7c2d1;color:var(--ink)}

/* ─── Log card ─── */
#log{margin-top:24px;display:none}
.log-card{background:var(--white);border:1px solid var(--line);border-radius:16px;padding:22px;box-shadow:0 8px 24px rgba(29,53,87,.05)}
.log-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.log-head strong{font-size:16px}

/* ─── Status badge ─── */
.badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;padding:5px 11px;border-radius:999px;background:#f2f4f7;color:#53627a}
.badge-queued{background:var(--pale);color:var(--blue)}
.badge-running{background:var(--greenBg);color:var(--green)}
.badge-done{background:var(--pale);color:var(--blue)}
.badge-failed,.badge-expired{background:var(--redBg);color:var(--red)}
.badge-cancelled{background:#f2f4f7;color:#53627a}
.bdot{width:7px;height:7px;border-radius:50%;background:currentColor}
.badge-running .bdot{animation:dotPulse 1s ease-in-out infinite}

/* ─── Progress ─── */
.progress{height:3px;border-radius:2px;background:var(--line);overflow:hidden;margin-bottom:14px;display:none}
.progress.active{display:block}
.progress-bar{height:100%;width:30%;background:var(--blue);border-radius:2px;animation:indeterminate 1.6s ease-in-out infinite}
@keyframes indeterminate{0%{transform:translateX(-100%)}50%{transform:translateX(200%)}100%{transform:translateX(400%)}}

/* ─── Timeline ─── */
#events{display:flex;flex-direction:column}
.ev{display:grid;grid-template-columns:30px 40px 1fr;gap:10px;min-height:48px;align-items:start;position:relative;padding:8px 0}
.ev+.ev{border-top:1px solid var(--line)}
.ev.new{animation:fadeSlide .35s ease-out both}
@keyframes fadeSlide{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.step-icon{width:26px;height:26px;border-radius:50%;border:2px solid #d0d7e2;display:grid;place-items:center;font-size:12px;color:var(--white);background:var(--white)}
.ev.kind-step .step-icon{background:var(--blue);border-color:var(--blue)}
.ev.kind-done .step-icon{background:var(--green);border-color:var(--green)}
.ev.kind-error .step-icon{background:var(--red);border-color:var(--red)}
.ev.kind-info .step-icon{background:#d0d7e2;border-color:#d0d7e2}
.t{color:var(--muted);font-variant-numeric:tabular-nums;font-size:12px;padding-top:4px;text-align:right}
.evtext{flex:1;min-width:0;padding-top:3px;font-size:14px;line-height:1.4}
.ev.kind-step .evtext{color:var(--ink);font-weight:600}
.ev.kind-done .evtext{color:var(--green);font-weight:600}
.ev.kind-error .evtext{color:var(--red)}
.ev.kind-info .evtext{color:var(--muted)}

/* ─── Footer ─── */
footer{text-align:center;padding:24px 16px 32px}
.trust{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:12px;letter-spacing:.01em;background:var(--pale);padding:8px 16px;border-radius:999px}

/* ─── Mobile ─── */
@media(max-width:680px){
  .shell{border:0}
  .topbar{padding:0 16px;height:54px}
  .brand{font-size:17px}
  .content{padding:24px 16px 20px}
  .hero{grid-template-columns:1fr}
  .hero-copy h2{font-size:30px}
  .req-card{box-shadow:none;border:1px solid var(--line)}
  .log-card{box-shadow:none}
  .pass-area .pass-lbl{display:none}
  input[type=password]{width:90px}
}
/* ─── Skills ─── */
.skills{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.skills .lbl{color:var(--muted);font-size:12px;font-weight:700;letter-spacing:.06em;margin-right:2px}
.skill{border:1px solid var(--line);border-radius:999px;padding:8px 14px;background:var(--white);color:var(--ink);font-size:14px;font-weight:600;cursor:pointer;transition:all .15s}
.skill:hover{border-color:var(--blue)}
.skill.on{background:var(--ink);border-color:var(--ink);color:#fff}
.skill-hint{color:var(--muted);font-size:12px;margin:-6px 0 12px}
/* ─── Agent question ─── */
#ask{display:none;margin:14px 0 6px;padding:14px;border-radius:12px;background:#fff7e6;border:1px solid #f5c26b}
#ask .q{font-weight:700;color:#8a5a00;margin-bottom:10px}
#ask .ask-row{display:flex;gap:8px}
#ans{flex:1;border:1px solid #f5c26b;border-radius:10px;padding:10px 12px;font:inherit;color:var(--ink);background:#fff}
#ans:focus{outline:none;border-color:#d89614}
#reply{border:0;border-radius:10px;padding:0 18px;background:#d89614;color:#fff;font-weight:700;cursor:pointer}
.badge-waiting{background:#fff7e6;color:#8a5a00}
.kind-ask .evtext{color:#8a5a00;font-weight:600}
.kind-answer .evtext{color:var(--blue)}
</style></head><body>
<div class="shell">

<header class="topbar">
  <div class="brand"><span class="brand-mark">P</span>PhonePilot</div>
  <div class="topbar-right">
    <div class="pass-area"><span class="pass-lbl">Passcode</span><input id="pass" type="password" placeholder="Enter" autocomplete="current-password"></div>
  </div>
</header>

<div class="content">
  <div class="hero">
    <div class="hero-copy">
      <div class="kicker">YOUR PERSONAL PHONE AGENT</div>
      <h2>Say what you need.<br>A phone gets it done.</h2>
      <p>Speak naturally or type a task. PhonePilot runs it on your real Android phone and shows you every step live.</p>
      <div class="chips">
        <span class="chip">Open WhatsApp and say hi to Vaishnav</span>
        <span class="chip">Open YouTube and play the first video</span>
        <span class="chip">Open Blinkit and search for tomato</span>
      </div>
    </div>

    <div class="req-card">
      <div class="req-head"><strong>New request</strong><span class="status-dot"><i class="sdot" id="liveDot"></i><span id="liveLabel">Ready</span></span></div>
      <div class="skills"><span class="lbl">SKILL</span>
        <button class="skill on" data-skill="" type="button">✨ Any app</button>
        <button class="skill" data-skill="blinkit" type="button">🛒 Blinkit</button>
        <button class="skill" data-skill="whatsapp_triage" type="button">💬 WhatsApp catch-up</button>
      </div>
      <div class="skill-hint" id="skillHint">Describe any task on any app.</div>
      <div class="voice-box">
        <div class="wave" id="waveViz"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
        <button id="mic" type="button">&#9679; Speak your request</button>
      </div>
      <textarea id="task" placeholder="Or type your request here..."></textarea>
      <div class="actions">
        <button id="go" type="button">Run on phone</button>
        <button id="stop" type="button">&#9632; Stop</button>
        <button id="clear" type="button">Clear</button>
      </div>
    </div>
  </div>

  <div id="log">
    <div class="log-card">
      <div class="log-head"><strong>Task progress</strong><div id="status"></div></div>
      <div class="progress" id="progressBar"><div class="progress-bar"></div></div>
      <div id="ask"><div class="q" id="q"></div><div class="ask-row"><input id="ans" placeholder="Type your answer" autocomplete="off"><button id="reply" type="button">Reply</button></div></div>
      <div id="events"></div>
    </div>
  </div>
</div>

<footer><span class="trust">&#128274; Your phone, your logins. Payments and OTPs are never automated.</span></footer>
</div>
<script>
const $=s=>document.querySelector(s);
const clearBtn=$('#clear'),pass=$('#pass'),task=$('#task'),go=$('#go'),stop=$('#stop'),mic=$('#mic');

pass.value=localStorage.getItem('pp_pass')||'';

/* chips */
document.querySelectorAll('.chip').forEach(c=>c.onclick=()=>{task.value=c.textContent;task.focus()});

let current=null,timer=null,prevCount=0;

const api=(path,opt={})=>fetch(path,{...opt,headers:{'content-type':'application/json','x-passcode':pass.value,...(opt.headers||{})}});

const BADGE={waiting:['Needs your answer','badge-waiting'],queued:['Queued','badge-queued'],running:['Running','badge-running'],done:['Complete','badge-done'],failed:['Failed','badge-failed'],cancelled:['Stopped','badge-cancelled'],expired:['Expired','badge-expired']};
const ICONS={ask:'?',answer:'↳',step:'✓',done:'✓',error:'!',info:'•'};

function render(t){
  $('#log').style.display='block';

  /* status badge */
  const sEl=$('#status');
  sEl.textContent='';
  const info=BADGE[t.status]||['Unknown',''];
  const badge=document.createElement('span');
  badge.className='badge '+info[1];
  const bdot=document.createElement('span');bdot.className='bdot';
  badge.appendChild(bdot);
  const lbl=document.createElement('span');lbl.textContent=info[0];
  badge.appendChild(lbl);
  sEl.appendChild(badge);

  /* live dot */
  const wait=t.status==='waiting';
  $('#ask').style.display=wait?'block':'none';
  if(wait){$('#q').textContent=t.question||'The agent has a question';if(document.activeElement!==$('#ans'))$('#ans').focus()}
  const live=t.status==='queued'||t.status==='running'||wait;
  const ld=$('#liveDot'),ll=$('#liveLabel');
  if(live){ld.classList.add('live');ll.textContent=wait?'Waiting for you':'Working'}
  else{ld.classList.remove('live');ll.textContent='Ready'}

  /* progress bar */
  const pb=$('#progressBar');
  if(live){pb.classList.add('active')}else{pb.classList.remove('active')}

  /* events */
  const evEl=$('#events');
  evEl.textContent='';
  const isNew=t.events.length>prevCount;
  prevCount=t.events.length;
  for(let i=0;i<t.events.length;i++){
    const e=t.events[i];
    const d=document.createElement('div');
    d.className='ev kind-'+e.kind;
    if(isNew&&i===t.events.length-1)d.classList.add('new');
    const ic=document.createElement('span');ic.className='step-icon';ic.textContent=ICONS[e.kind]||'';
    const tt=document.createElement('span');tt.className='t';
    tt.textContent='+'+Math.max(0,Math.round((e.at-t.createdAt)/1000))+'s';
    const tx=document.createElement('span');tx.className='evtext';
    tx.textContent=e.text;
    d.appendChild(ic);d.appendChild(tt);d.appendChild(tx);evEl.appendChild(d);
  }

  stop.style.display=live?'block':'none';
  go.style.display=live?'none':'block';
  go.disabled=live;
  if(!live){clearInterval(timer);timer=null;prevCount=0}
}

async function poll(){if(!current)return;try{const r=await api('/v1/tasks/'+current);if(r.ok)render((await r.json()).task)}catch(e){}}

go.onclick=async()=>{
  localStorage.setItem('pp_pass',pass.value);
  const r=await api('/v1/tasks',{method:'POST',body:JSON.stringify({task:task.value,skill:skill||null})});
  const j=await r.json();
  if(!r.ok){
    $('#log').style.display='block';
    const sEl=$('#status');sEl.textContent='';
    const badge=document.createElement('span');badge.className='badge badge-failed';
    const bdot=document.createElement('span');bdot.className='bdot';badge.appendChild(bdot);
    const lbl=document.createElement('span');lbl.textContent=j.error?.message||'Error '+r.status;badge.appendChild(lbl);
    sEl.appendChild(badge);
    $('#progressBar').classList.remove('active');
    $('#events').textContent='';return;
  }
  prevCount=0;current=j.id;render(j.task);clearInterval(timer);timer=setInterval(poll,1000);
};

stop.onclick=async()=>{if(current){const r=await api('/v1/tasks/'+current+'/cancel',{method:'POST'});if(r.ok)render((await r.json()).task)}};

clearBtn.onclick=async()=>{
  if(!confirm('Delete all tasks? A running task will stop.'))return;
  localStorage.setItem('pp_pass',pass.value);
  const r=await api('/v1/tasks/clear',{method:'POST'});const j=await r.json();
  clearInterval(timer);timer=null;current=null;prevCount=0;task.value='';go.disabled=false;go.style.display='block';stop.style.display='none';
  $('#log').style.display='block';$('#events').textContent='';$('#progressBar').classList.remove('active');
  const sEl=$('#status');sEl.textContent='';
  const badge=document.createElement('span');badge.className='badge badge-done';
  const bdot=document.createElement('span');bdot.className='bdot';badge.appendChild(bdot);
  const lbl=document.createElement('span');lbl.textContent=r.ok?'Cleared '+j.cleared+' task(s)':'Error';badge.appendChild(lbl);
  sEl.appendChild(badge);
};

/* ─── Skills ─── */
let skill='';
const HINTS={'':['Describe any task on any app.','Or type your request here...'],
  blinkit:['Blinkit skill: just name the item — it searches, adds to cart, and stops at checkout.','e.g. order tomato'],
  whatsapp_triage:['Reads unread chats and replies only to urgent personal messages. Never replies in groups.','e.g. check my WhatsApp and reply to anything urgent']};
document.querySelectorAll('.skill').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.skill').forEach(x=>x.classList.remove('on'));b.classList.add('on');skill=b.dataset.skill;
  const h=HINTS[skill]||HINTS[''];$('#skillHint').textContent=h[0];task.placeholder=h[1];
  if(skill==='whatsapp_triage'&&!task.value.trim())task.value='Check my WhatsApp and reply to anything urgent'});
/* ─── Answering the agent ─── */
$('#reply').onclick=async()=>{const v=$('#ans').value.trim();if(!v||!current)return;
  const r=await api('/v1/tasks/'+current+'/answer',{method:'POST',body:JSON.stringify({answer:v})});
  if(r.ok){$('#ans').value='';render((await r.json()).task)}};
$('#ans').onkeydown=e=>{if(e.key==='Enter')$('#reply').click()};

/* ─── Speech recognition ─── */
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
const waveViz=$('#waveViz');
if(!SR){mic.title='Voice not supported in this browser';mic.style.opacity=.35}
else{const rec=new SR();rec.lang='en-IN';rec.interimResults=true;rec.continuous=false;
  rec.onresult=e=>{task.value=[...e.results].map(r=>r[0].transcript).join('')};
  rec.onend=()=>{mic.classList.remove('on');mic.textContent='● Speak your request';waveViz.classList.remove('active');$('#liveDot').classList.remove('live');$('#liveLabel').textContent='Ready';if(task.value.trim())go.click()};
  mic.onclick=()=>{if(mic.classList.contains('on')){rec.stop()}else{task.value='';mic.classList.add('on');mic.textContent='■ Listening…';waveViz.classList.add('active');$('#liveDot').classList.add('live');$('#liveLabel').textContent='Listening';rec.start()}}}
</script></body></html>`;
