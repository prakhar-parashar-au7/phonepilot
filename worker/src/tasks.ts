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
  :root{--bg:#0b0d12;--card:#151924;--line:#232a3a;--fg:#e8ecf4;--dim:#8a93a8;--acc:#6ee7b7;--warn:#fbbf24;--err:#f87171}
  *{box-sizing:border-box}body{margin:0;font:16px/1.45 -apple-system,system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
  main{max-width:640px;margin:0 auto;padding:28px 18px 60px}
  h1{font-size:26px;margin:0}.sub{color:var(--dim);margin:4px 0 22px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px}
  textarea,input{width:100%;background:#0f131c;border:1px solid var(--line);border-radius:12px;color:var(--fg);padding:12px;font:inherit}
  textarea{min-height:84px;resize:vertical}
  .row{display:flex;gap:10px;margin-top:12px}
  button{border:0;border-radius:12px;padding:12px 16px;font:600 15px inherit;cursor:pointer}
  #mic{background:#1f2636;color:var(--fg);flex:0 0 auto;font-size:20px;width:56px}
  #mic.on{background:var(--err);animation:p 1s infinite}@keyframes p{50%{opacity:.6}}
  #go{background:var(--acc);color:#04291c;flex:1}#go:disabled{opacity:.5}
  #stop{background:var(--err);color:#300;display:none}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
  .chip{background:#1b2130;border:1px solid var(--line);color:var(--dim);border-radius:999px;padding:6px 12px;font-size:13px;cursor:pointer}
  #log{margin-top:18px;display:none}.ev{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);font-size:14px}
  .ev:last-child{border:0}.t{color:var(--dim);font-variant-numeric:tabular-nums;flex:0 0 46px}
  .done{color:var(--acc)}.error{color:var(--err)}.info{color:var(--dim)}
  #status{font-weight:600;margin-bottom:6px}.pass{margin-bottom:12px}
  .ghost{background:transparent;border:1px solid var(--line);color:var(--dim);flex:1;font-weight:500}
  footer{color:var(--dim);font-size:12px;margin-top:26px;text-align:center}
</style></head><body><main>
<h1>📱 PhonePilot</h1><p class="sub">Say it. Watch the phone do it.</p>
<div class="card">
  <input id="pass" class="pass" type="password" placeholder="Passcode" autocomplete="current-password">
  <textarea id="task" placeholder="e.g. Open WhatsApp and say hi to Vaishnav"></textarea>
  <div class="row"><button id="mic" title="Speak">🎙</button><button id="go">Run on phone</button><button id="stop">Stop</button></div>
  <div class="row"><button id="clear" class="ghost">Clear all tasks · start fresh</button></div>
  <div class="chips">
    <span class="chip">Open WhatsApp and say hi to Vaishnav</span>
    <span class="chip">Open YouTube and play the first video</span>
    <span class="chip">Open Blinkit and search for tomato</span>
  </div>
</div>
<div id="log" class="card"><div id="status"></div><div id="events"></div></div>
<footer>Your phone, your logins. Payments and OTPs are never automated.</footer>
</main><script>
const $=s=>document.querySelector(s),clearBtn=$('#clear'),pass=$('#pass'),task=$('#task'),go=$('#go'),stop=$('#stop'),mic=$('#mic');
pass.value=localStorage.getItem('pp_pass')||'';
document.querySelectorAll('.chip').forEach(c=>c.onclick=()=>{task.value=c.textContent;task.focus()});
let current=null,timer=null,t0=0;
const api=(path,opt={})=>fetch(path,{...opt,headers:{'content-type':'application/json','x-passcode':pass.value,...(opt.headers||{})}});
const LABEL={queued:'⏳ Queued',running:'🤖 Working on the phone…',done:'✅ Done',failed:'⚠️ Failed',cancelled:'⏹ Stopped',expired:'⌛ Expired'};
function render(t){
  $('#log').style.display='block';$('#status').textContent=LABEL[t.status]||t.status;
  $('#events').innerHTML='';
  for(const e of t.events){const d=document.createElement('div');d.className='ev';
    const tt=document.createElement('span');tt.className='t';tt.textContent='+'+Math.max(0,Math.round((e.at-t.createdAt)/1000))+'s';
    const tx=document.createElement('span');tx.className=e.kind;tx.textContent=e.text;d.append(tt,tx);$('#events').append(d)}
  const live=t.status==='queued'||t.status==='running';stop.style.display=live?'block':'none';go.disabled=live;
  if(!live){clearInterval(timer);timer=null}
}
async function poll(){if(!current)return;const r=await api('/v1/tasks/'+current);if(r.ok)render((await r.json()).task)}
go.onclick=async()=>{
  localStorage.setItem('pp_pass',pass.value);
  const r=await api('/v1/tasks',{method:'POST',body:JSON.stringify({task:task.value})});
  const j=await r.json();
  if(!r.ok){$('#log').style.display='block';$('#status').textContent='⚠️ '+(j.error?.message||r.status);$('#events').innerHTML='';return}
  current=j.id;render(j.task);clearInterval(timer);timer=setInterval(poll,1000);
};
stop.onclick=async()=>{if(current){const r=await api('/v1/tasks/'+current+'/cancel',{method:'POST'});if(r.ok)render((await r.json()).task)}};
clearBtn.onclick=async()=>{
  if(!confirm('Delete all tasks? A running task will stop.'))return;
  localStorage.setItem('pp_pass',pass.value);
  const r=await api('/v1/tasks/clear',{method:'POST'});const j=await r.json();
  clearInterval(timer);timer=null;current=null;task.value='';go.disabled=false;stop.style.display='none';
  $('#log').style.display='block';$('#events').innerHTML='';
  $('#status').textContent=r.ok?'🧹 Cleared '+j.cleared+' task(s). Fresh start.':'⚠️ '+(j.error?.message||r.status);
};
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
if(!SR){mic.title='Voice not supported in this browser';mic.style.opacity=.4}
else{const rec=new SR();rec.lang='en-IN';rec.interimResults=true;rec.continuous=false;
  rec.onresult=e=>{task.value=[...e.results].map(r=>r[0].transcript).join('')};
  rec.onend=()=>{mic.classList.remove('on');if(task.value.trim())go.click()};
  mic.onclick=()=>{if(mic.classList.contains('on')){rec.stop()}else{task.value='';mic.classList.add('on');rec.start()}}}
</script></body></html>`;
