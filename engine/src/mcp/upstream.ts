import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Instance, ServerDefinition } from "../core/types.js";
import { Vault } from "../core/vault.js";
import { HarborOAuthProvider } from "../core/oauth.js";

/**
 * Resolve an instance's credentials into the concrete env vars and headers the
 * upstream server needs. Secrets are pulled from the vault at connection time
 * and never written to disk or exposed to the requesting client.
 */
export async function resolveInjection(
  def: ServerDefinition,
  instance: Instance,
): Promise<{ env: Record<string, string>; headers: Record<string, string>; missing: string[] }> {
  const env: Record<string, string> = { ...def.env };
  const headers: Record<string, string> = {};
  const missing: string[] = [];

  for (const spec of def.credentials) {
    const target = spec.as ?? (def.transport === "stdio" ? "env" : "header");
    // OAuth instances get their Authorization from the token provider, not a
    // static header credential — so don't inject or require header creds.
    if (instance.authMode === "oauth" && target === "header") continue;
    const raw = instance.credentials[spec.key] ?? spec.default;
    let value: string | null = raw ?? null;
    if (raw != null) value = await Vault.resolve(raw);
    if (value == null || value === "") {
      if (spec.required) missing.push(spec.key);
      continue;
    }
    if (target === "header") headers[spec.key] = value;
    else env[spec.key] = value;
  }

  // Filesystem servers take their scoped root as a trailing argument.
  return { env, headers, missing };
}

export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
}

/**
 * A live connection to one real MCP server (one Harbor instance). Owns the
 * child process (stdio) or HTTP session, and caches the tool list.
 */
const CONNECT_TIMEOUT_MS = Number(process.env.HARBOR_CONNECT_TIMEOUT_MS) || 15_000;
const MAX_BACKOFF_MS = 30_000;
const CLOSE_DRAIN_MS = 5_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} (timed out after ${ms}ms)`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export class UpstreamConnection {
  readonly instance: Instance;
  readonly definition: ServerDefinition;
  private client?: Client;
  private connected = false;
  private connecting = false;
  private disposed = false;
  private connectError?: string;
  tools: UpstreamTool[] = [];

  /** Number of tool calls in flight — close() waits for these to drain. */
  private inFlight = 0;
  /** Earliest time a supervised reconnect should be attempted (epoch ms). */
  nextRetryAt = 0;
  private backoffMs = 1_000;
  /** Invoked when the connection drops or recovers so the gateway can re-route. */
  onStateChange?: () => void;

  constructor(instance: Instance, definition: ServerDefinition) {
    this.instance = instance;
    this.definition = definition;
  }

  get status(): "connected" | "error" | "idle" {
    if (this.connected) return "connected";
    if (this.connectError) return "error";
    return "idle";
  }

  get error(): string | undefined {
    return this.connectError;
  }

  get isConnecting(): boolean {
    return this.connecting;
  }

  async connect(): Promise<void> {
    if (this.connected || this.connecting || this.disposed) return;
    this.connecting = true;
    try {
      const { env, headers, missing } = await resolveInjection(this.definition, this.instance);
      if (missing.length) {
        this.connectError = `missing credentials: ${missing.join(", ")}`;
        this.scheduleRetry();
        throw new Error(this.connectError);
      }

      const client = new Client({ name: "harbor-gateway", version: "0.1.0" }, { capabilities: {} });

      try {
        const transport = this.buildTransport(env, headers);
        // A hanging server must not block the gateway forever.
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "upstream connect failed");

        // Detect the upstream dying out from under us and recover.
        client.onclose = () => this.handleDrop("upstream connection closed");
        client.onerror = (err) => this.handleDrop(err?.message ?? "upstream error");

        this.client = client;
        this.connected = true;
        this.connectError = undefined;
        this.backoffMs = 1_000;
        this.nextRetryAt = 0;
        await this.refreshTools();
      } catch (err: any) {
        this.connectError = err?.message ?? String(err);
        this.scheduleRetry();
        try {
          await client.close();
        } catch {
          /* ignore */
        }
        throw err;
      }
    } finally {
      this.connecting = false;
    }
  }

  private buildTransport(env: Record<string, string>, headers: Record<string, string>) {
    if (this.definition.transport === "stdio") {
      if (!this.definition.command) throw new Error("stdio definition missing command");
      const args = [...this.definition.args];
      if (this.definition.filesystemRoot && this.instance.root) args.push(this.instance.root);
      return new StdioClientTransport({
        command: this.definition.command,
        args,
        env: { ...getDefaultEnvironment(), ...env },
        stderr: "pipe",
      });
    }
    // OAuth instances attach a token provider that reuses/refreshes stored
    // tokens silently; consent (redirectToAuthorization) throws at runtime.
    const authProvider =
      this.instance.authMode === "oauth"
        ? new HarborOAuthProvider(this.instance.id, { redirectUrl: "http://127.0.0.1:0/callback" })
        : undefined;

    if (this.definition.transport === "http") {
      if (!this.definition.url) throw new Error("http definition missing url");
      return new StreamableHTTPClientTransport(new URL(this.definition.url), { requestInit: { headers }, authProvider });
    }
    if (!this.definition.url) throw new Error("sse definition missing url");
    return new SSEClientTransport(new URL(this.definition.url), { requestInit: { headers }, authProvider });
  }

  /** Called when a previously-good connection drops. Marks it for reconnect. */
  private handleDrop(reason: string): void {
    if (this.disposed || !this.connected) return;
    this.connected = false;
    this.client = undefined;
    this.tools = [];
    this.connectError = reason;
    this.scheduleRetry();
    this.onStateChange?.();
  }

  private scheduleRetry(): void {
    this.nextRetryAt = Date.now() + this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  async refreshTools(): Promise<UpstreamTool[]> {
    if (!this.client) return [];
    try {
      const res = await this.client.listTools();
      this.tools = (res.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations as Record<string, unknown> | undefined,
      }));
    } catch {
      this.tools = [];
    }
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown> | undefined): Promise<any> {
    if (!this.client) throw new Error("not connected");
    this.inFlight++;
    try {
      return await this.client.callTool({ name, arguments: args ?? {} });
    } finally {
      this.inFlight--;
    }
  }

  async listResources() {
    if (!this.client) return { resources: [] };
    try {
      return await this.client.listResources();
    } catch {
      return { resources: [] };
    }
  }

  async readResource(uri: string) {
    if (!this.client) throw new Error("not connected");
    return this.client.readResource({ uri });
  }

  async listPrompts() {
    if (!this.client) return { prompts: [] };
    try {
      return await this.client.listPrompts();
    } catch {
      return { prompts: [] };
    }
  }

  async getPrompt(name: string, args: Record<string, string> | undefined) {
    if (!this.client) throw new Error("not connected");
    return this.client.getPrompt({ name, arguments: args ?? {} });
  }

  /**
   * Close the connection, first letting in-flight tool calls drain so a profile
   * switch doesn't abort work already underway (bounded by CLOSE_DRAIN_MS).
   */
  async close(): Promise<void> {
    this.disposed = true;
    const deadline = Date.now() + CLOSE_DRAIN_MS;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    this.connected = false;
    if (this.client) {
      const client = this.client;
      this.client = undefined;
      client.onclose = undefined as any;
      client.onerror = undefined as any;
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
  }
}
