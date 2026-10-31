import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { TaskInbox, TASK_TTL_MS, type KvStorage } from "../src/tasks";

class MemoryKv implements KvStorage {
  map = new Map<string, unknown>();
  async get<T>(key: string) { return structuredClone(this.map.get(key)) as T | undefined; }
  async put<T>(key: string, value: T) { this.map.set(key, structuredClone(value)); }
  async delete(keys: string[]) { keys.forEach((k) => this.map.delete(k)); return keys.length; }
  async list<T>({ prefix }: { prefix: string }) {
    return new Map([...this.map].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T]));
  }
}

function setup() {
  let now = 1_000_000;
  const inbox = new TaskInbox({ storage: new MemoryKv() }, {}, () => now);
  const env = {
    PHONEPILOT_DEVICE_TOKEN: "dev-token",
    PHONEPILOT_WEB_PASSCODE: "web-pass",
    OPENAI_API_KEY: "not-real",
    DEVICE_RATE_LIMIT: { limit: vi.fn(async () => ({ success: true })) },
    DAILY_LIMIT: { idFromName: vi.fn(), get: vi.fn() },
    TASK_INBOX: { idFromName: vi.fn(() => "id"), get: vi.fn(() => inbox) },
  };
  const req = (path: string, init: RequestInit & { web?: boolean; host?: boolean } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.web) headers["x-passcode"] = "web-pass";
    if (init.host) headers.authorization = "Bearer dev-token";
    return worker.fetch(new Request(`https://w.example${path}`, { method: init.method ?? "GET", headers, body: init.body }), env as never);
  };
  return { req, advance: (ms: number) => { now += ms; } };
}

describe("hosted tasks", () => {
  it("serves the web page", async () => {
    const { req } = setup();
    const res = await req("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("PhonePilot");
  });

  it("requires the web passcode and the device token", async () => {
    const { req } = setup();
    expect((await req("/v1/tasks", { method: "POST", body: JSON.stringify({ task: "hi" }) })).status).toBe(401);
    expect((await req("/v1/host/next", { method: "POST", web: true })).status).toBe(401);
  });

  it("runs create -> claim -> events -> done end to end", async () => {
    const { req } = setup();
    const created = await req("/v1/tasks", { method: "POST", web: true, body: JSON.stringify({ task: "Open WhatsApp and say hi to Vaishnav" }) });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const claimed = (await (await req("/v1/host/next", { method: "POST", host: true })).json()) as { task: { id: string; status: string } };
    expect(claimed.task).toMatchObject({ id, status: "running" });
    expect(((await (await req("/v1/host/next", { method: "POST", host: true })).json()) as { task: unknown }).task).toBeNull();

    await req(`/v1/host/tasks/${id}/events`, { method: "POST", host: true, body: JSON.stringify({ kind: "step", text: "tapped vaishnav" }) });
    await req(`/v1/host/tasks/${id}/events`, { method: "POST", host: true, body: JSON.stringify({ kind: "done", text: "Sent hi", status: "done" }) });

    const view = (await (await req(`/v1/tasks/${id}`, { web: true })).json()) as { task: { status: string; events: { text: string }[] } };
    expect(view.task.status).toBe("done");
    expect(view.task.events.map((e) => e.text)).toContain("tapped vaishnav");
  });

  it("tells the host to stop after the user cancels", async () => {
    const { req } = setup();
    const { id } = (await (await req("/v1/tasks", { method: "POST", web: true, body: JSON.stringify({ task: "Open YouTube" }) })).json()) as { id: string };
    await req("/v1/host/next", { method: "POST", host: true });
    await req(`/v1/tasks/${id}/cancel`, { method: "POST", web: true });
    const res = await req(`/v1/host/tasks/${id}/events`, { method: "POST", host: true, body: JSON.stringify({ kind: "step", text: "tap" }) });
    expect(await res.json()).toEqual({ cancelled: true });
  });

  it("expires stale queued tasks instead of running them", async () => {
    const { req, advance } = setup();
    await req("/v1/tasks", { method: "POST", web: true, body: JSON.stringify({ task: "Open YouTube" }) });
    advance(TASK_TTL_MS + 1);
    expect(((await (await req("/v1/host/next", { method: "POST", host: true })).json()) as { task: unknown }).task).toBeNull();
  });

  it("clears every task and the host sees the running one as gone", async () => {
    const { req } = setup();
    const { id } = (await (await req("/v1/tasks", { method: "POST", web: true, body: JSON.stringify({ task: "Open YouTube" }) })).json()) as { id: string };
    await req("/v1/tasks", { method: "POST", web: true, body: JSON.stringify({ task: "Open Blinkit" }) });
    await req("/v1/host/next", { method: "POST", host: true });
    expect((await (await req("/v1/tasks/clear", { method: "POST", web: true })).json())).toEqual({ cleared: 2 });
    expect((await req(`/v1/host/tasks/${id}/events`, { method: "POST", host: true, body: JSON.stringify({ kind: "step", text: "x" }) })).status).toBe(404);
    expect(((await (await req("/v1/host/next", { method: "POST", host: true })).json()) as { task: unknown }).task).toBeNull();
    expect((await req("/v1/tasks/clear", { method: "POST" })).status).toBe(401);
  });

  it("asks the user and hands the answer back to the host once", async () => {
    const { req } = setup();
    const { id } = (await (await req("/v1/tasks", { method: "POST", web: true, body: JSON.stringify({ task: "Log me into Tinder", skill: null }) })).json()) as { id: string };
    await req("/v1/host/next", { method: "POST", host: true });
    await req(`/v1/host/tasks/${id}/events`, { method: "POST", host: true, body: JSON.stringify({ kind: "ask", text: "What is your phone number?", status: "waiting" }) });
    const waiting = (await (await req(`/v1/tasks/${id}`, { web: true })).json()) as { task: { status: string; question: string } };
    expect(waiting.task).toMatchObject({ status: "waiting", question: "What is your phone number?" });
    expect(await (await req(`/v1/host/tasks/${id}/answer`, { method: "POST", host: true })).json()).toEqual({ status: "waiting", answer: null });
    await req(`/v1/tasks/${id}/answer`, { method: "POST", web: true, body: JSON.stringify({ answer: "9876543210" }) });
    expect(await (await req(`/v1/host/tasks/${id}/answer`, { method: "POST", host: true })).json()).toEqual({ status: "running", answer: "9876543210" });
    expect(await (await req(`/v1/host/tasks/${id}/answer`, { method: "POST", host: true })).json()).toEqual({ status: "running", answer: null });
  });

  it("accepts known skills and rejects unknown ones", async () => {
    const { req } = setup();
    expect((await req("/v1/tasks", { method: "POST", web: true, body: JSON.stringify({ task: "order tomato", skill: "blinkit" }) })).status).toBe(201);
    expect((await req("/v1/tasks", { method: "POST", web: true, body: JSON.stringify({ task: "order tomato", skill: "rm-rf" }) })).status).toBe(400);
    const claimed = (await (await req("/v1/host/next", { method: "POST", host: true })).json()) as { task: { skill: string } };
    expect(claimed.task.skill).toBe("blinkit");
  });

  it("blocks sensitive tasks and keeps next-action 404s intact", async () => {
    const { req } = setup();
    expect((await req("/v1/tasks", { method: "POST", web: true, body: JSON.stringify({ task: "type my OTP 1234" }) })).status).toBe(400);
    expect((await req("/v1/unknown")).status).toBe(404);
  });
});
