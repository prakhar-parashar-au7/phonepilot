/**
 * Hosted task inbox: website -> cloud queue -> phone host (pulls) -> status back to website.
 *
 * Web routes (x-passcode header = PHONEPILOT_WEB_PASSCODE):
 *   POST /v1/tasks              {task}        -> {id}
 *   GET  /v1/tasks/:id                        -> {task}
 *   POST /v1/tasks/:id/cancel                 -> {task}
 *   POST /v1/tasks/clear                      -> {cleared}  (deletes every task; a running one stops)
 * Host routes (Bearer PHONEPILOT_DEVICE_TOKEN):
 *   POST /v1/host/next                        -> {task} | {task:null}
 *   POST /v1/host/tasks/:id/events {kind,text,status?} -> {cancelled}
 *
 * The phone host only ever connects outward; nothing on the internet can reach the phone.
 */

export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "expired";
export type TaskEvent = { at: number; kind: "info" | "step" | "done" | "error"; text: string };
export type Task = { id: string; task: string; status: TaskStatus; createdAt: number; updatedAt: number; events: TaskEvent[] };

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

  async create(text: string): Promise<Task> {
    const t = this.now();
    const task: Task = { id: `${t.toString(36)}-${crypto.randomUUID().slice(0, 8)}`, task: text, status: "queued", createdAt: t, updatedAt: t, events: [] };
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
    await this.save(task);
    return { cancelled: false };
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
    if (op === "create") return json({ task: await this.create(String(body.task)) });
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
const KINDS = ["info", "step", "done", "error"];
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
      const res = await call(env, "create", { task });
      const created = ((await res.json()) as { task: Task }).task;
      return json({ id: created.id, task: created }, 201);
    }
    if (request.method === "POST" && pathname === "/v1/tasks/clear") return call(env, "clear");
    const m = pathname.match(/^\/v1\/tasks\/([^/]+)(\/cancel)?$/);
    if (!m || !ID.test(m[1])) return fail(404, "not_found");
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
  const m = pathname.match(/^\/v1\/host\/tasks\/([^/]+)\/events$/);
  if (!m || !ID.test(m[1])) return fail(404, "not_found");
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { return fail(400, "invalid_request"); }
  const status = body.status;
  if (!KINDS.includes(String(body.kind)) || typeof body.text !== "string" || body.text.length < 1 || body.text.length > 300) return fail(400, "invalid_request");
  if (status !== undefined && !["done", "failed"].includes(String(status))) return fail(400, "invalid_request");
  const res = await call(env, "event", { id: m[1], kind: body.kind, text: body.text, status });
  const result = await res.json();
  return result ? json(result) : fail(404, "not_found");
}

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PhonePilot</title>
<style>
:root{--bg:#0a0c10;--card:#13161e;--card2:#181c26;--line:#1e2536;--fg:#eaf0fa;--dim:#6b7694;--acc:#34d399;--acc2:#6ee7b7;--warn:#fbbf24;--err:#f87171;--errBg:rgba(248,113,113,.12);--accBg:rgba(52,211,153,.1);--blue:#60a5fa}
*{box-sizing:border-box;margin:0}
html{-webkit-text-size-adjust:100%}
body{font:17px/1.5 -apple-system,system-ui,'Segoe UI',sans-serif;background:var(--bg);color:var(--fg);min-height:100dvh}
main{max-width:560px;margin:0 auto;padding:36px 20px 80px}

/* ─── Header ─── */
.hdr{display:flex;align-items:center;gap:12px;margin-bottom:6px}
.logo{font-size:38px;line-height:1}
h1{font-size:28px;font-weight:700;letter-spacing:-.02em}
.sub{color:var(--dim);font-size:15px;margin-bottom:28px}

/* ─── Card ─── */
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:18px}

/* ─── Passcode collapse ─── */
.pass-wrap{margin-bottom:14px}
.pass-toggle{display:flex;align-items:center;gap:6px;background:none;border:0;color:var(--dim);font:13px/1 inherit;cursor:pointer;padding:0 0 0 2px;letter-spacing:.01em}
.pass-toggle .arr{display:inline-block;transition:transform .2s;font-size:10px}
.pass-toggle.open .arr{transform:rotate(90deg)}
.pass-inner{overflow:hidden;max-height:0;transition:max-height .25s ease}
.pass-inner.show{max-height:60px;margin-top:8px}
input[type=password]{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:12px;color:var(--fg);padding:10px 12px;font:14px/1.4 inherit}

/* ─── Textarea ─── */
textarea{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:14px;color:var(--fg);padding:14px;font:inherit;min-height:90px;resize:vertical;transition:border-color .15s}
textarea:focus{outline:none;border-color:var(--acc)}

/* ─── Buttons row ─── */
.row{display:flex;gap:10px;margin-top:14px}
button{border:0;border-radius:12px;padding:12px 18px;font:600 15px/1 inherit;cursor:pointer;transition:opacity .12s,transform .1s}
button:active{transform:scale(.97)}
#mic{background:#1a2030;color:var(--fg);flex:0 0 auto;font-size:22px;width:54px;height:48px;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
#mic.on{background:var(--err);color:#fff}
#mic.on::before{content:'';position:absolute;inset:-4px;border-radius:14px;border:2px solid var(--err);animation:micPulse 1.4s ease-out infinite}
@keyframes micPulse{0%{transform:scale(.95);opacity:.7}100%{transform:scale(1.3);opacity:0}}
#go{background:var(--acc);color:#052e16;flex:1;font-size:16px}
#go:disabled{opacity:.4;cursor:default}
#stop{background:var(--err);color:#fff;display:none;flex:1;font-size:16px}

/* ─── Chips ─── */
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.chip{background:var(--card2);border:1px solid var(--line);color:var(--dim);border-radius:999px;padding:7px 14px;font-size:13px;cursor:pointer;transition:border-color .15s,color .15s}
.chip:hover{border-color:var(--acc);color:var(--fg)}

/* ─── Log ─── */
#log{margin-top:20px;display:none}

/* ─── Status pill ─── */
.pill{display:inline-flex;align-items:center;gap:7px;padding:5px 14px;border-radius:999px;font:600 14px/1 inherit;margin-bottom:10px}
.pill-queued{background:rgba(96,165,250,.12);color:var(--blue)}
.pill-running{background:rgba(251,191,36,.12);color:var(--warn)}
.pill-done{background:var(--accBg);color:var(--acc)}
.pill-failed,.pill-expired{background:var(--errBg);color:var(--err)}
.pill-cancelled{background:rgba(107,118,148,.14);color:var(--dim)}
.pill-dot{width:8px;height:8px;border-radius:50%;background:currentColor}
.pill-running .pill-dot{animation:blink 1s steps(2,start) infinite}
@keyframes blink{to{visibility:hidden}}

/* ─── Progress bar ─── */
.progress{height:3px;border-radius:2px;background:var(--line);overflow:hidden;margin-bottom:12px;display:none}
.progress.active{display:block}
.progress-bar{height:100%;width:30%;background:var(--warn);border-radius:2px;animation:indeterminate 1.6s ease-in-out infinite}
@keyframes indeterminate{0%{transform:translateX(-100%)}50%{transform:translateX(200%)}100%{transform:translateX(400%)}}

/* ─── Timeline events ─── */
#events{display:flex;flex-direction:column;gap:0}
.ev{display:flex;gap:12px;padding:10px 0;position:relative;font-size:15px}
.ev+.ev{border-top:1px solid var(--line)}
.ev.new{animation:fadeSlide .35s ease-out both}
@keyframes fadeSlide{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.t{color:var(--dim);font-variant-numeric:tabular-nums;flex:0 0 42px;font-size:13px;padding-top:1px;text-align:right}
.evtext{flex:1;min-width:0}
.step{color:var(--fg)}
.done{color:var(--acc)}
.error{color:var(--err)}
.info{color:var(--dim);font-size:14px}

/* ─── Clear row ─── */
.row2{display:flex;gap:10px;margin-top:10px}
.ghost{background:transparent;border:1px solid var(--line);color:var(--dim);flex:1;font-weight:500;font-size:14px;padding:10px 14px}
.ghost:hover{border-color:#3a4460;color:var(--fg)}

/* ─── Footer ─── */
footer{text-align:center;margin-top:36px;padding:0 8px}
.trust{display:inline-flex;align-items:center;gap:6px;color:var(--dim);font-size:12px;letter-spacing:.01em}
.shield{font-size:14px}

/* ─── Mobile ─── */
@media(max-width:480px){
  main{padding:24px 14px 60px}
  h1{font-size:24px}
  .logo{font-size:32px}
  textarea{min-height:76px}
  .ev{font-size:14px}
}
</style></head><body><main>

<div class="hdr"><span class="logo">📱</span><h1>PhonePilot</h1></div>
<p class="sub">Say it. Watch the phone do it.</p>

<div class="card">
  <div class="pass-wrap">
    <button class="pass-toggle" id="passToggle" type="button"><span class="arr">&#9654;</span> Passcode</button>
    <div class="pass-inner" id="passInner"><input id="pass" type="password" placeholder="Enter passcode" autocomplete="current-password"></div>
  </div>
  <textarea id="task" placeholder="e.g. Open WhatsApp and say hi to Vaishnav"></textarea>
  <div class="row"><button id="mic" title="Speak">&#127908;</button><button id="go">Run on phone</button><button id="stop">Stop</button></div>
  <div class="row2"><button id="clear" class="ghost">Clear all tasks</button></div>
  <div class="chips">
    <span class="chip">Open WhatsApp and say hi to Vaishnav</span>
    <span class="chip">Open YouTube and play the first video</span>
    <span class="chip">Open Blinkit and search for tomato</span>
  </div>
</div>

<div id="log" class="card">
  <div id="status"></div>
  <div class="progress" id="progressBar"><div class="progress-bar"></div></div>
  <div id="events"></div>
</div>

<footer><span class="trust"><span class="shield">&#128274;</span> Your phone, your logins. Payments and OTPs are never automated.</span></footer>
</main><script>
const $=s=>document.querySelector(s);
const clearBtn=$('#clear'),pass=$('#pass'),task=$('#task'),go=$('#go'),stop=$('#stop'),mic=$('#mic');

/* passcode collapse — auto-open if empty, collapse once saved */
const passToggle=$('#passToggle'),passInner=$('#passInner');
pass.value=localStorage.getItem('pp_pass')||'';
if(!pass.value){passInner.classList.add('show');passToggle.classList.add('open')}
passToggle.onclick=()=>{passInner.classList.toggle('show');passToggle.classList.toggle('open')};

/* chips */
document.querySelectorAll('.chip').forEach(c=>c.onclick=()=>{task.value=c.textContent;task.focus()});

let current=null,timer=null,prevCount=0;

const api=(path,opt={})=>fetch(path,{...opt,headers:{'content-type':'application/json','x-passcode':pass.value,...(opt.headers||{})}});

const PILL={queued:['Queued','pill-queued'],running:['Working','pill-running'],done:['Done','pill-done'],failed:['Failed','pill-failed'],cancelled:['Stopped','pill-cancelled'],expired:['Expired','pill-expired']};

function render(t){
  $('#log').style.display='block';

  /* status pill */
  const sEl=$('#status');
  sEl.textContent='';
  const info=PILL[t.status]||['Unknown',''];
  const pill=document.createElement('span');
  pill.className='pill '+info[1];
  const dot=document.createElement('span');dot.className='pill-dot';
  pill.appendChild(dot);
  const lbl=document.createElement('span');lbl.textContent=info[0];
  pill.appendChild(lbl);
  sEl.appendChild(pill);

  /* progress bar */
  const live=t.status==='queued'||t.status==='running';
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
    d.className='ev';
    if(isNew&&i===t.events.length-1)d.classList.add('new');
    const tt=document.createElement('span');tt.className='t';
    tt.textContent='+'+Math.max(0,Math.round((e.at-t.createdAt)/1000))+'s';
    const tx=document.createElement('span');tx.className='evtext '+e.kind;
    tx.textContent=e.text;
    d.appendChild(tt);d.appendChild(tx);evEl.appendChild(d);
  }

  stop.style.display=live?'flex':'none';
  go.style.display=live?'none':'flex';
  go.disabled=live;
  if(!live){clearInterval(timer);timer=null;prevCount=0}
}

async function poll(){if(!current)return;try{const r=await api('/v1/tasks/'+current);if(r.ok)render((await r.json()).task)}catch(e){}}

go.onclick=async()=>{
  localStorage.setItem('pp_pass',pass.value);
  /* auto-collapse passcode on first run */
  passInner.classList.remove('show');passToggle.classList.remove('open');
  const r=await api('/v1/tasks',{method:'POST',body:JSON.stringify({task:task.value})});
  const j=await r.json();
  if(!r.ok){
    $('#log').style.display='block';
    const sEl=$('#status');sEl.textContent='';
    const pill=document.createElement('span');pill.className='pill pill-failed';
    const dot=document.createElement('span');dot.className='pill-dot';pill.appendChild(dot);
    const lbl=document.createElement('span');lbl.textContent=j.error?.message||'Error '+r.status;pill.appendChild(lbl);
    sEl.appendChild(pill);
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
  clearInterval(timer);timer=null;current=null;prevCount=0;task.value='';go.disabled=false;go.style.display='flex';stop.style.display='none';
  $('#log').style.display='block';$('#events').textContent='';$('#progressBar').classList.remove('active');
  const sEl=$('#status');sEl.textContent='';
  const pill=document.createElement('span');pill.className='pill pill-done';
  const dot=document.createElement('span');dot.className='pill-dot';pill.appendChild(dot);
  const lbl=document.createElement('span');lbl.textContent=r.ok?'Cleared '+j.cleared+' task(s)':'Error';pill.appendChild(lbl);
  sEl.appendChild(pill);
};

/* ─── Speech recognition ─── */
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
if(!SR){mic.title='Voice not supported in this browser';mic.style.opacity=.35}
else{const rec=new SR();rec.lang='en-IN';rec.interimResults=true;rec.continuous=false;
  rec.onresult=e=>{task.value=[...e.results].map(r=>r[0].transcript).join('')};
  rec.onend=()=>{mic.classList.remove('on');if(task.value.trim())go.click()};
  mic.onclick=()=>{if(mic.classList.contains('on')){rec.stop()}else{task.value='';mic.classList.add('on');rec.start()}}}
</script></body></html>`;
