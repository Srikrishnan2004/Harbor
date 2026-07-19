import { ConfigStore } from "./store.js";
import { UpstreamConnection } from "../mcp/upstream.js";
import { resolveInjection } from "../mcp/upstream.js";

export interface HealthResult {
  instanceId: string;
  ok: boolean;
  tools: string[];
  missingCredentials: string[];
  error?: string;
  durationMs: number;
}

/**
 * Connect to an instance's real server, list its tools, and report. Used by
 * `harbor test` and the health dots in the UI. Always tears the connection
 * down afterwards.
 */
export async function testInstance(store: ConfigStore, instanceId: string): Promise<HealthResult> {
  const started = Date.now();
  const instance = store.getInstance(instanceId);
  if (!instance) {
    return { instanceId, ok: false, tools: [], missingCredentials: [], error: "no such instance", durationMs: 0 };
  }
  const def = store.getDefinition(instance.definition);
  if (!def) {
    return {
      instanceId,
      ok: false,
      tools: [],
      missingCredentials: [],
      error: `missing definition "${instance.definition}"`,
      durationMs: Date.now() - started,
    };
  }

  const { missing } = await resolveInjection(def, instance);
  if (missing.length) {
    return {
      instanceId,
      ok: false,
      tools: [],
      missingCredentials: missing,
      error: `missing credentials: ${missing.join(", ")}`,
      durationMs: Date.now() - started,
    };
  }

  const conn = new UpstreamConnection(instance, def);
  try {
    await conn.connect();
    const tools = conn.tools.map((t) => t.name);
    return { instanceId, ok: true, tools, missingCredentials: [], durationMs: Date.now() - started };
  } catch (err: any) {
    return {
      instanceId,
      ok: false,
      tools: [],
      missingCredentials: [],
      error: err?.message ?? String(err),
      durationMs: Date.now() - started,
    };
  } finally {
    await conn.close();
  }
}
