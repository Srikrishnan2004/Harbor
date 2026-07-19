import fs from "node:fs";
import { auditPath, ensureHome } from "./paths.js";

export interface AuditEntry {
  ts: string; // ISO timestamp
  client?: string;
  instance: string;
  tool: string; // original (un-namespaced) tool name
  exposedTool?: string; // namespaced name the client called
  argsSummary?: string;
  outcome: "ok" | "error" | "denied" | "blocked";
  detail?: string;
  resultSize?: number;
  durationMs?: number;
}

/**
 * Append-only local audit log (JSONL). Every upstream tool call the gateway
 * makes is recorded here — this is how you find out an agent hit prod at 2am.
 */
export class AuditLog {
  static append(entry: Omit<AuditEntry, "ts"> & { ts?: string }): void {
    ensureHome();
    const record: AuditEntry = { ts: new Date().toISOString(), ...entry };
    fs.appendFileSync(auditPath(), JSON.stringify(record) + "\n");
  }

  static read(limit = 200, filter?: Partial<Pick<AuditEntry, "client" | "instance" | "outcome">>): AuditEntry[] {
    const path = auditPath();
    if (!fs.existsSync(path)) return [];
    const lines = fs.readFileSync(path, "utf8").split("\n").filter(Boolean);
    const entries: AuditEntry[] = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as AuditEntry;
        if (filter?.client && e.client !== filter.client) continue;
        if (filter?.instance && e.instance !== filter.instance) continue;
        if (filter?.outcome && e.outcome !== filter.outcome) continue;
        entries.push(e);
      } catch {
        /* skip malformed line */
      }
    }
    return entries.slice(-limit);
  }

  /** Read the entire audit history (for analytics), optionally filtered. */
  static readAll(filter?: Partial<Pick<AuditEntry, "client" | "instance" | "outcome">>): AuditEntry[] {
    return AuditLog.read(Number.MAX_SAFE_INTEGER, filter);
  }

  static clear(): void {
    if (fs.existsSync(auditPath())) fs.rmSync(auditPath());
  }
}

/** A short, non-secret summary of tool-call arguments for the audit trail. */
export function summarizeArgs(args: unknown): string {
  if (args == null) return "";
  try {
    const json = JSON.stringify(args);
    return json.length > 200 ? json.slice(0, 197) + "..." : json;
  } catch {
    return String(args);
  }
}
