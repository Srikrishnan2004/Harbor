import { ConfigStore } from "./store.js";
import { ServerDefinition, sanitizePrefix } from "./types.js";

/**
 * A thin client for the official MCP registry (registry.modelcontextprotocol.io).
 * Harbor is not a registry — it *consumes* one: `harbor search` lists servers and
 * `harbor install` converts a registry entry into a Harbor server definition.
 * The base URL is overridable (HARBOR_REGISTRY_URL) so alternates and tests work.
 */

export function registryBase(): string {
  return (process.env.HARBOR_REGISTRY_URL || "https://registry.modelcontextprotocol.io").replace(/\/$/, "");
}

interface RegistryEnvVar {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  format?: string;
  value?: string;
}
interface RegistryPackage {
  registryType?: string; // npm | pypi | oci | nuget ...
  identifier?: string;
  version?: string;
  transport?: { type?: string };
  environmentVariables?: RegistryEnvVar[];
  packageArguments?: Array<{ type?: string; name?: string; value?: string }>;
  runtimeArguments?: Array<{ type?: string; name?: string; value?: string }>;
}
interface RegistryRemote {
  type?: string; // streamable-http | sse
  url: string;
  headers?: RegistryEnvVar[];
}
export interface RegistryServer {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  packages?: RegistryPackage[];
  remotes?: RegistryRemote[];
}

async function getJson(path: string): Promise<any> {
  const res = await fetch(registryBase() + path, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`registry ${path} → ${res.status}`);
  return res.json();
}

/** Search the registry; returns the server records (newest match first). */
export async function searchRegistry(query: string, limit = 20): Promise<RegistryServer[]> {
  const data = await getJson(`/v0/servers?search=${encodeURIComponent(query)}&limit=${limit}`);
  return (data.servers ?? []).map((e: any) => e.server as RegistryServer);
}

/** Fetch a single server by exact name (falls back to best search match). */
export async function getRegistryServer(name: string): Promise<RegistryServer | null> {
  const results = await searchRegistry(name, 20);
  return results.find((s) => s.name === name) ?? results[0] ?? null;
}

function friendlyId(name: string): string {
  // "io.github.foo/bar-mcp" -> "bar-mcp"; "ac.inference.sh/mcp" -> "mcp"
  const seg = name.split("/").pop() ?? name;
  const id = sanitizePrefix(seg).replace(/_/g, "-").toLowerCase();
  return id || sanitizePrefix(name).replace(/_/g, "-").toLowerCase();
}

function stdioCommand(pkg: RegistryPackage): { command: string; args: string[] } | null {
  const id = pkg.identifier;
  if (!id) return null;
  const ver = pkg.version && pkg.version !== "latest" ? pkg.version : undefined;
  switch (pkg.registryType) {
    case "npm":
      return { command: "npx", args: ["-y", ver ? `${id}@${ver}` : id] };
    case "pypi":
      return { command: "uvx", args: [ver ? `${id}==${ver}` : id] };
    case "oci":
    case "docker":
      return { command: "docker", args: ["run", "-i", "--rm", ver ? `${id}:${ver}` : id] };
    case "nuget":
      return { command: "dnx", args: [id] };
    default:
      return null;
  }
}

function credsFromEnv(vars: RegistryEnvVar[] | undefined, as: "env" | "header") {
  return (vars ?? []).map((v) => ({
    key: v.name,
    type: v.isSecret ? ("secret" as const) : ("string" as const),
    required: !!v.isRequired,
    as,
    ...(v.value ? { default: v.value } : {}),
  }));
}

/**
 * Convert a registry server record into a Harbor server definition. Prefers a
 * stdio package; falls back to the first remote. Environment variables and
 * remote headers become the definition's credentials.
 */
export function serverToDefinition(server: RegistryServer, idOverride?: string): ServerDefinition {
  const id = idOverride ?? friendlyId(server.name);
  const displayName = server.title || (server.name.split("/").pop() ?? server.name);

  const pkg = (server.packages ?? []).find((p) => (p.transport?.type ?? "stdio") === "stdio" && stdioCommand(p));
  if (pkg) {
    const cmd = stdioCommand(pkg)!;
    return ServerDefinition.parse({
      id,
      name: displayName,
      description: server.description,
      transport: "stdio",
      command: cmd.command,
      args: cmd.args,
      credentials: credsFromEnv(pkg.environmentVariables, "env"),
      tags: ["registry"],
    });
  }

  const remote = server.remotes?.[0];
  if (remote?.url) {
    return ServerDefinition.parse({
      id,
      name: displayName,
      description: server.description,
      transport: remote.type === "sse" ? "sse" : "http",
      url: remote.url,
      credentials: credsFromEnv(remote.headers, "header"),
      tags: ["registry"],
    });
  }

  throw new Error(`"${server.name}" has no installable package or remote`);
}

export interface InstallResult {
  definition: ServerDefinition;
  created: boolean;
}

/** Install a registry server as a Harbor definition (idempotent by id). */
export async function installFromRegistry(
  store: ConfigStore,
  name: string,
  opts: { id?: string } = {},
): Promise<InstallResult> {
  const server = await getRegistryServer(name);
  if (!server) throw new Error(`no registry server matching "${name}"`);
  const def = serverToDefinition(server, opts.id);
  const created = !store.getDefinition(def.id);
  store.upsertDefinition(def);
  return { definition: def, created };
}
