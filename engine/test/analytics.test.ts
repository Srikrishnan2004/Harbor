import { describe, it, expect, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { AuditLog } from "../src/core/audit.js";
import { computeUsage, parseDuration, formatBytes } from "../src/core/analytics.js";

beforeEach(() => {
  process.env.HARBOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-an-"));
  process.env.HARBOR_VAULT = "file";
  AuditLog.clear();
});

function seed() {
  const base = { ts: undefined };
  // supabase-prod: 3 ok + 1 error, some bytes/durations
  AuditLog.append({ ...base, client: "claude-code", instance: "supabase-prod", tool: "query", exposedTool: "supabase_prod__query", outcome: "ok", resultSize: 100, durationMs: 10 });
  AuditLog.append({ ...base, client: "claude-code", instance: "supabase-prod", tool: "query", outcome: "ok", resultSize: 300, durationMs: 30 });
  AuditLog.append({ ...base, client: "codex", instance: "supabase-prod", tool: "list_tables", outcome: "ok", resultSize: 50, durationMs: 20 });
  AuditLog.append({ ...base, client: "claude-code", instance: "supabase-prod", tool: "delete_row", outcome: "denied", detail: "not approved" });
  // github-work: 1 ok + 1 blocked
  AuditLog.append({ ...base, client: "codex", instance: "github-work", tool: "get_pr", outcome: "ok", resultSize: 200, durationMs: 40 });
  AuditLog.append({ ...base, client: "codex", instance: "github-work", tool: "write_file", outcome: "blocked", detail: "scope" });
}

describe("parseDuration", () => {
  it("parses units", () => {
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("24h")).toBe(24 * 3_600_000);
    expect(parseDuration("7d")).toBe(7 * 86_400_000);
    expect(parseDuration("nope")).toBeNull();
  });
});

describe("computeUsage", () => {
  it("aggregates per-instance calls, errors, bytes, and top tools", () => {
    seed();
    const r = computeUsage();
    expect(r.totals.calls).toBe(6);
    expect(r.totals.errors).toBe(2); // 1 denied + 1 blocked
    expect(r.totals.bytes).toBe(650);
    expect(r.totals.instances).toBe(2);

    // Sorted by calls desc → supabase-prod first (4 calls).
    const prod = r.instances[0];
    expect(prod.instance).toBe("supabase-prod");
    expect(prod.calls).toBe(4);
    expect(prod.ok).toBe(3);
    expect(prod.errors).toBe(1);
    expect(prod.denied).toBe(1);
    expect(prod.bytes).toBe(450);
    expect(prod.avgMs).toBe(20); // (10+30+20)/3
    expect(prod.topTools[0]).toEqual({ tool: "query", calls: 2 });

    const gh = r.instances.find((i) => i.instance === "github-work")!;
    expect(gh.blocked).toBe(1);

    // by-client tally.
    expect(r.byClient.find((c) => c.client === "claude-code")?.calls).toBe(3);
  });

  it("honors the --since window using an injected clock", () => {
    // Two entries with controlled timestamps via direct append.
    AuditLog.append({ ts: new Date("2026-01-01T00:00:00Z").toISOString(), instance: "x", tool: "t", outcome: "ok" } as any);
    AuditLog.append({ ts: new Date("2026-01-10T00:00:00Z").toISOString(), instance: "x", tool: "t", outcome: "ok" } as any);
    const now = new Date("2026-01-10T01:00:00Z").getTime();
    const r = computeUsage({ sinceMs: parseDuration("24h")!, now });
    expect(r.totals.calls).toBe(1); // only the Jan-10 entry is within 24h
  });

  it("can filter to a single instance", () => {
    seed();
    const r = computeUsage({ instance: "github-work" });
    expect(r.instances).toHaveLength(1);
    expect(r.totals.calls).toBe(2);
  });
});

describe("formatBytes", () => {
  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
