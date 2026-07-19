import { DiscoveredServer } from "../adapters/index.js";
import { ConfigStore } from "./store.js";
import { Instance, ServerDefinition, sanitizePrefix } from "./types.js";

export interface ImportResult {
  definitionsCreated: string[];
  instancesCreated: string[];
  skipped: string[];
}

/**
 * Turn discovered servers (from a repo or client config) into library entries:
 * a reusable definition per distinct server shape, and an instance per server.
 * Secrets found inline in env are NOT imported as values — the resulting
 * definition lists them as credentials to be filled via `harbor auth`.
 */
export function importServers(
  store: ConfigStore,
  servers: DiscoveredServer[],
  opts: { colorCycle?: boolean } = {},
): ImportResult {
  const result: ImportResult = { definitionsCreated: [], instancesCreated: [], skipped: [] };
  const colors = ["blue", "green", "teal", "purple", "orange", "pink"] as const;
  let colorIdx = 0;

  for (const s of servers) {
    if (s.name === "harbor") {
      result.skipped.push(s.name);
      continue; // never import the gateway entry itself
    }

    const defId = defIdFor(s);
    if (!store.getDefinition(defId)) {
      const def = definitionFromDiscovered(defId, s);
      store.upsertDefinition(def);
      result.definitionsCreated.push(defId);
    }

    let instanceId = sanitizePrefix(s.name).replace(/_/g, "-") || defId;
    let n = 1;
    while (store.getInstance(instanceId)) {
      // If the exact same server already exists, skip; otherwise disambiguate.
      instanceId = `${sanitizePrefix(s.name).replace(/_/g, "-")}-${++n}`;
    }

    const instance: Instance = Instance.parse({
      id: instanceId,
      definition: defId,
      label: s.name,
      color: opts.colorCycle ? colors[colorIdx++ % colors.length] : "gray",
      credentials: nonSecretEnv(s),
    });
    store.upsertInstance(instance);
    result.instancesCreated.push(instanceId);
  }
  return result;
}

function defIdFor(s: DiscoveredServer): string {
  if (s.transport !== "stdio" && s.url) {
    try {
      return "remote-" + sanitizePrefix(new URL(s.url).hostname.replace(/\./g, "-"));
    } catch {
      return "remote-" + sanitizePrefix(s.name);
    }
  }
  // Group stdio servers by their package/command so prod+staging share a def.
  const pkg = s.args?.find((a) => a.startsWith("@") || a.includes("/") || a.includes("mcp"));
  return sanitizePrefix(pkg?.replace(/[@/]/g, "-").replace(/^-+/, "") ?? s.command ?? s.name);
}

function definitionFromDiscovered(id: string, s: DiscoveredServer): ServerDefinition {
  const credentials = Object.keys(s.env ?? {}).map((key) => ({
    key,
    type: looksSecret(key) ? ("secret" as const) : ("string" as const),
    required: true,
    as: "env" as const,
  }));
  return ServerDefinition.parse({
    id,
    name: s.name,
    transport: s.transport,
    command: s.command,
    args: s.args ?? [],
    url: s.url,
    credentials,
  });
}

function nonSecretEnv(s: DiscoveredServer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.env ?? {})) {
    if (!looksSecret(k)) out[k] = v; // keep non-secret config; secrets need `harbor auth`
  }
  return out;
}

function looksSecret(key: string): boolean {
  // Connection URLs / DSNs commonly embed credentials, so treat them as secret.
  return /token|secret|key|password|passwd|auth|credential|dsn|_url$|database_url/i.test(key);
}
