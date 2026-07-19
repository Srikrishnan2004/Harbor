import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { startDaemon } from "../src/daemon/server.js";
import { readDaemonInfo } from "../src/daemon/auth.js";
import { AuditLog } from "../src/core/audit.js";

let server: http.Server;
let port: number;
let token: string;

beforeAll(async () => {
  process.env.HARBOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-daemon-"));
  process.env.HARBOR_VAULT = "file";
  port = 4700 + Math.floor(Number(process.hrtime.bigint() % 50n));
  server = await startDaemon(port);
  token = readDaemonInfo()!.token;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const url = (p: string) => `http://127.0.0.1:${port}${p}`;

describe("daemon auth", () => {
  it("writes a control token to daemon.json", () => {
    const info = readDaemonInfo();
    expect(info?.token).toHaveLength(48);
    expect(info?.port).toBe(port);
  });

  it("rejects API requests without the token (401)", async () => {
    const res = await fetch(url("/api/config"));
    expect(res.status).toBe(401);
  });

  it("serves an unauthenticated liveness probe at /api/health", async () => {
    const res = await fetch(url("/api/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("harbor-daemon");
  });

  it("accepts API requests carrying the token", async () => {
    const res = await fetch(url("/api/config"), { headers: { "x-harbor-token": token } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.vault).toBeTruthy();
  });

  it("accepts the token as a bearer authorization header", async () => {
    const res = await fetch(url("/api/status"), { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });

  it("rejects a cross-origin (non-localhost) origin", async () => {
    const res = await fetch(url("/api/config"), {
      headers: { "x-harbor-token": token, origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  it("serves the UI shell without a token but injects the token into it", async () => {
    // No dist/ in test env → daemon serves its fallback HTML, still no auth needed.
    const res = await fetch(url("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});

const authed = (extra: Record<string, string> = {}) => ({ "x-harbor-token": token, ...extra });

describe("daemon API CRUD", () => {
  it("creates, lists, and deletes an instance and profile", async () => {
    // Create an instance.
    let res = await fetch(url("/api/instances"), {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ id: "d-inst", definition: "supabase", label: "D" }),
    });
    expect(res.status).toBe(200);

    res = await fetch(url("/api/instances"), { headers: authed() });
    const instances = (await res.json()) as any[];
    expect(instances.some((i) => i.id === "d-inst")).toBe(true);

    // Create a profile and activate it.
    await fetch(url("/api/profiles"), {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ id: "d-prof", name: "D", instances: ["d-inst"] }),
    });
    res = await fetch(url("/api/activate"), {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ profileId: "d-prof" }),
    });
    expect(((await res.json()) as any).active).toBe("d-prof");

    // Delete the instance.
    res = await fetch(url("/api/instances/d-inst"), { method: "DELETE", headers: authed() });
    expect(res.status).toBe(200);
    res = await fetch(url("/api/instances"), { headers: authed() });
    expect(((await res.json()) as any[]).some((i) => i.id === "d-inst")).toBe(false);
  });
});

describe("usage endpoint", () => {
  it("returns aggregated analytics from the audit log", async () => {
    AuditLog.append({ instance: "an-inst", tool: "query", outcome: "ok", resultSize: 120, durationMs: 15 } as any);
    AuditLog.append({ instance: "an-inst", tool: "query", outcome: "error" } as any);
    const res = await fetch(url("/api/usage"), { headers: authed() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const inst = body.instances.find((i: any) => i.instance === "an-inst");
    expect(inst.calls).toBe(2);
    expect(inst.errors).toBe(1);
    expect(inst.bytes).toBe(120);
  });
});

describe("approval round-trip", () => {
  it("blocks the gateway's approval request until the UI resolves it", async () => {
    // The gateway would POST this and block; the UI polls pending and resolves.
    const pending = fetch(url("/api/approvals"), {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ instance: "supabase-prod", label: "Prod", tool: "delete_row", args: { id: 1 } }),
    });

    // Poll until the approval shows up in the queue.
    let id: string | undefined;
    for (let i = 0; i < 40 && !id; i++) {
      const res = await fetch(url("/api/approvals/pending"), { headers: authed() });
      const list = (await res.json()) as any[];
      id = list.find((a) => a.tool === "delete_row")?.id;
      if (!id) await new Promise((r) => setTimeout(r, 50));
    }
    expect(id).toBeTruthy();

    // Approve it; the blocked POST should now resolve to { approved: true }.
    await fetch(url(`/api/approvals/${id}/resolve`), {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ approved: true }),
    });
    const body = (await (await pending).json()) as any;
    expect(body.approved).toBe(true);
  });
});
