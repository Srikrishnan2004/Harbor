import { AuditLog, AuditEntry } from "./audit.js";

/**
 * Usage analytics derived from the audit log. Harbor can't see token counts —
 * MCP tool calls don't report them — so "cost" here is call volume, error rate,
 * and bytes returned per instance, which is what actually drives spend and risk.
 */

export interface InstanceUsage {
  instance: string;
  calls: number;
  ok: number;
  errors: number; // error + denied + blocked
  denied: number;
  blocked: number;
  bytes: number; // sum of result sizes
  avgMs: number | null;
  lastUsed: string | null;
  topTools: Array<{ tool: string; calls: number }>;
}

export interface UsageReport {
  since: string | null;
  totals: { calls: number; ok: number; errors: number; bytes: number; instances: number };
  instances: InstanceUsage[];
  topTools: Array<{ instance: string; tool: string; calls: number }>;
  byClient: Array<{ client: string; calls: number }>;
}

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse a duration like "24h", "7d", "30m", "90s" into milliseconds. */
export function parseDuration(spec: string): number | null {
  const m = /^(\d+)\s*([smhd])$/.exec(spec.trim());
  if (!m) return null;
  return parseInt(m[1], 10) * UNITS[m[2]];
}

export interface UsageOptions {
  /** Only count calls at or after now - sinceMs. */
  sinceMs?: number;
  instance?: string;
  /** Injected clock (epoch ms); defaults to Date.now(). Lets callers/tests fix time. */
  now?: number;
}

export function computeUsage(opts: UsageOptions = {}): UsageReport {
  const now = opts.now ?? Date.now();
  const cutoff = opts.sinceMs != null ? now - opts.sinceMs : null;
  const entries = AuditLog.readAll(opts.instance ? { instance: opts.instance } : undefined).filter((e) => {
    if (cutoff == null) return true;
    return new Date(e.ts).getTime() >= cutoff;
  });

  const byInstance = new Map<string, AuditEntry[]>();
  const clientCounts = new Map<string, number>();
  for (const e of entries) {
    (byInstance.get(e.instance) ?? byInstance.set(e.instance, []).get(e.instance)!).push(e);
    if (e.client) clientCounts.set(e.client, (clientCounts.get(e.client) ?? 0) + 1);
  }

  const instances: InstanceUsage[] = [];
  const globalTopTools: Array<{ instance: string; tool: string; calls: number }> = [];

  for (const [instance, list] of byInstance) {
    const toolCounts = new Map<string, number>();
    let ok = 0,
      denied = 0,
      blocked = 0,
      errored = 0,
      bytes = 0,
      durSum = 0,
      durN = 0;
    let lastUsed: string | null = null;
    for (const e of list) {
      toolCounts.set(e.tool, (toolCounts.get(e.tool) ?? 0) + 1);
      if (e.outcome === "ok") ok++;
      else if (e.outcome === "denied") denied++;
      else if (e.outcome === "blocked") blocked++;
      else errored++;
      bytes += e.resultSize ?? 0;
      if (typeof e.durationMs === "number") {
        durSum += e.durationMs;
        durN++;
      }
      if (!lastUsed || e.ts > lastUsed) lastUsed = e.ts;
    }
    const topTools = [...toolCounts.entries()]
      .map(([tool, calls]) => ({ tool, calls }))
      .sort((a, b) => b.calls - a.calls);
    for (const t of topTools.slice(0, 3)) globalTopTools.push({ instance, tool: t.tool, calls: t.calls });

    instances.push({
      instance,
      calls: list.length,
      ok,
      errors: errored + denied + blocked,
      denied,
      blocked,
      bytes,
      avgMs: durN ? Math.round(durSum / durN) : null,
      lastUsed,
      topTools: topTools.slice(0, 5),
    });
  }

  instances.sort((a, b) => b.calls - a.calls);
  globalTopTools.sort((a, b) => b.calls - a.calls);

  return {
    since: cutoff != null ? new Date(cutoff).toISOString() : null,
    totals: {
      calls: entries.length,
      ok: instances.reduce((n, i) => n + i.ok, 0),
      errors: instances.reduce((n, i) => n + i.errors, 0),
      bytes: instances.reduce((n, i) => n + i.bytes, 0),
      instances: instances.length,
    },
    instances,
    topTools: globalTopTools.slice(0, 10),
    byClient: [...clientCounts.entries()].map(([client, calls]) => ({ client, calls })).sort((a, b) => b.calls - a.calls),
  };
}

/** Human-friendly byte formatter for CLI/UI. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
