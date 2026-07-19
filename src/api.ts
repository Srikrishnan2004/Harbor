// Thin client for the Harbor control daemon. Works both when the UI is served
// by the daemon (same origin) and in Vite dev (cross-origin to 127.0.0.1:4747).

const DAEMON_PORT = 4747;

// The daemon injects window.__HARBOR_TOKEN__ into the HTML it serves. In Vite
// dev (cross-origin) supply it via VITE_HARBOR_TOKEN instead.
const TOKEN: string =
  (typeof window !== "undefined" && (window as any).__HARBOR_TOKEN__) ||
  (import.meta as any).env?.VITE_HARBOR_TOKEN ||
  "";

function servedByDaemon(): boolean {
  return typeof window !== "undefined" && window.location.port === String(DAEMON_PORT);
}

function base(): string {
  if (servedByDaemon()) return ""; // same origin
  const proto = window.location.protocol === "https:" ? "https:" : "http:";
  return `${proto}//${window.location.hostname || "127.0.0.1"}:${DAEMON_PORT}`;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (TOKEN) headers["x-harbor-token"] = TOKEN;
  const res = await fetch(base() + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? `${method} ${path} → ${res.status}`);
  }
  return res.json();
}

export interface CredentialSpec {
  key: string;
  type: "secret" | "string";
  required: boolean;
  as?: "env" | "header";
}
export interface Definition {
  id: string;
  name: string;
  transport: string;
  command?: string;
  args: string[];
  url?: string;
  credentials: CredentialSpec[];
  builtin: boolean;
  filesystemRoot: boolean;
  tags: string[];
}
export interface Instance {
  id: string;
  definition: string;
  label: string;
  color: string;
  enabled: boolean;
  readonly: boolean;
  confirmWrites: boolean;
  production: boolean;
  authMode?: "token" | "oauth";
  allowTools?: string[];
  denyTools?: string[];
  root?: string;
  prefix?: string;
  credentials: Record<string, string>;
  tags: string[];
}
export interface Profile {
  id: string;
  name: string;
  description?: string;
  instances: string[];
  warnOnActivate?: string;
}
export interface Binding {
  scope: "project" | "client" | "global";
  match?: string;
  profile: string;
}
export interface Config {
  settings: { alwaysPrefix: boolean; daemonPort: number; defaultProfile?: string };
  definitions: Definition[];
  instances: Instance[];
  profiles: Profile[];
  bindings: Binding[];
  vault: string;
  home: string;
}
export interface RegistryServer {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  packages?: Array<{ registryType?: string; transport?: { type?: string } }>;
  remotes?: Array<{ type?: string; url: string }>;
}
export interface ClientInfo {
  id: string;
  displayName: string;
  configPath: string;
  detected: boolean;
  installed: boolean;
}
export interface AuditEntry {
  ts: string;
  client?: string;
  instance: string;
  tool: string;
  exposedTool?: string;
  argsSummary?: string;
  outcome: "ok" | "error" | "denied" | "blocked";
  detail?: string;
  durationMs?: number;
}
export interface InstanceUsage {
  instance: string;
  calls: number;
  ok: number;
  errors: number;
  denied: number;
  blocked: number;
  bytes: number;
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
export interface Status {
  perClient: { client: string; installed: boolean; profile: string | null; reason: string }[];
  gateways: { client?: string; profile: string | null; instances: any[] }[];
  vault: string;
  profiles: { id: string; name: string; production: boolean; instances: any[] }[];
  active: string | null;
}
export interface HealthResult {
  instanceId: string;
  ok: boolean;
  tools: string[];
  missingCredentials: string[];
  error?: string;
  durationMs: number;
}
export interface PendingApproval {
  id: string;
  instance: string;
  label: string;
  tool: string;
  args: unknown;
  client?: string;
  createdAt: number;
}

export const api = {
  config: () => req<Config>("GET", "/api/config"),
  status: (cwd?: string) => req<Status>("GET", `/api/status${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`),
  saveInstance: (i: Partial<Instance>) => req<Instance>("POST", "/api/instances", i),
  deleteInstance: (id: string) => req("DELETE", `/api/instances/${id}`),
  auth: (id: string, key: string, value: string) => req("POST", `/api/instances/${id}/auth`, { key, value }),
  oauth: (id: string) => req<{ ok: boolean; error?: string }>("POST", `/api/instances/${id}/oauth`),
  test: (id: string) => req<HealthResult>("POST", `/api/instances/${id}/test`),
  saveProfile: (p: Partial<Profile>) => req<Profile>("POST", "/api/profiles", p),
  deleteProfile: (id: string) => req("DELETE", `/api/profiles/${id}`),
  activate: (profileId: string | null) => req("POST", "/api/activate", { profileId }),
  bind: (b: Binding) => req("POST", "/api/bind", b),
  unbind: (scope: string, match?: string) => req("POST", "/api/unbind", { scope, match }),
  scan: (dir: string) => req<any>("GET", `/api/scan?dir=${encodeURIComponent(dir)}`),
  import: (opts: { path?: string; client?: string }) => req<any>("POST", "/api/import", opts),
  reconcile: (opts: { path: string; profile?: string; client?: string }) => req<any>("POST", "/api/reconcile", opts),
  audit: (limit = 100) => req<AuditEntry[]>("GET", `/api/audit?limit=${limit}`),
  usage: (since?: string) => req<UsageReport>("GET", `/api/usage${since ? `?since=${since}` : ""}`),
  registrySearch: (q: string, limit = 15) => req<RegistryServer[]>("GET", `/api/registry/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  registryInstall: (name: string, id?: string) => req<{ definition: Definition; created: boolean }>("POST", "/api/registry/install", { name, id }),
  clients: () => req<ClientInfo[]>("GET", "/api/clients"),
  setup: (client: string, uninstall = false) => req("POST", "/api/setup", { client, uninstall }),
  pendingApprovals: () => req<PendingApproval[]>("GET", "/api/approvals/pending"),
  resolveApproval: (id: string, approved: boolean) => req("POST", `/api/approvals/${id}/resolve`, { approved }),
};
