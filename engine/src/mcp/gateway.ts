import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ConfigStore } from "../core/store.js";
import { resolveProfile, ResolveContext, Resolution } from "../core/resolver.js";
import { Instance } from "../core/types.js";
import { instancePrefix, namespacedName } from "../core/namespace.js";
import { AuditLog, summarizeArgs } from "../core/audit.js";
import {
  checkFilesystemScope,
  isFilteredByReadonly,
  isFilteredByToolPolicy,
  requiresConfirmation,
} from "../core/safety.js";
import { harborHome, configPath, runtimePath } from "../core/paths.js";
import { UpstreamConnection, UpstreamTool } from "./upstream.js";

export type ApprovalFn = (req: {
  instance: Instance;
  tool: string;
  args: unknown;
  client?: string;
}) => Promise<boolean>;

interface ToolRoute {
  instanceId: string;
  originalName: string;
}

export interface GatewayOptions {
  client?: string;
  cwd?: string;
  approve?: ApprovalFn;
  /** Called after each (re)activation with the current resolution. */
  onActivate?: (resolution: Resolution, instances: Instance[]) => void;
}

/**
 * The Harbor Gateway. One MCP server that a client connects to; behind it,
 * the union of the active profile's instances, namespaced, credential-injected,
 * safety-filtered, and audited. Profile switches take effect live via a config
 * watch + tools/list_changed notification — no client restart.
 */
export class HarborGateway {
  readonly server: Server;
  private opts: GatewayOptions;
  private connections = new Map<string, UpstreamConnection>();
  private toolRoutes = new Map<string, ToolRoute>();
  private exposedTools: Array<{ name: string; description: string; inputSchema: unknown; annotations?: Record<string, unknown> }> = [];
  private resourceOwners = new Map<string, string>(); // uri -> instanceId
  private promptRoutes = new Map<string, ToolRoute>(); // exposed prompt name -> route
  private alwaysPrefix = true;
  private activeProfileId: string | null = null;
  private watchTimer?: NodeJS.Timeout;
  private reloading = false;
  private reloadPending = false;
  private supervisor?: NodeJS.Timeout;

  constructor(opts: GatewayOptions = {}) {
    this.opts = opts;
    this.server = new Server(
      { name: "harbor", version: "0.1.0" },
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );
    this.registerHandlers();
  }

  private ctx(): ResolveContext {
    return { client: this.opts.client, cwd: this.opts.cwd };
  }

  /** Connect the active profile and start watching for changes. */
  async start(): Promise<void> {
    await this.reload();
    this.watch();
    this.startSupervisor();
  }

  get profileId(): string | null {
    return this.activeProfileId;
  }

  /**
   * Reconcile connections with the active profile. Coalesced: a change that
   * arrives mid-reload sets a pending flag and re-runs once, so no config edit
   * is silently dropped and reloads never overlap.
   */
  private async reload(): Promise<void> {
    if (this.reloading) {
      this.reloadPending = true;
      return;
    }
    this.reloading = true;
    try {
      do {
        this.reloadPending = false;
        await this.reloadOnce();
      } while (this.reloadPending);
    } finally {
      this.reloading = false;
    }
  }

  private async reloadOnce(): Promise<void> {
    const store = ConfigStore.load();
    this.alwaysPrefix = store.settings.alwaysPrefix;
    const resolution = resolveProfile(store, this.ctx());
    const instances = resolution.profileId ? store.profileInstances(resolution.profileId) : [];
    const wanted = new Map(instances.map((i) => [i.id, i]));

    // Disconnect instances no longer in the profile (or whose config changed).
    // close() drains in-flight calls first, so a switch won't abort live work.
    const toClose: UpstreamConnection[] = [];
    for (const [id, conn] of this.connections) {
      const stillWanted = wanted.get(id);
      if (!stillWanted || JSON.stringify(stillWanted) !== JSON.stringify(conn.instance)) {
        this.connections.delete(id);
        toClose.push(conn);
      }
    }

    // Connect new / changed instances.
    for (const inst of instances) {
      if (this.connections.has(inst.id)) continue;
      const def = store.getDefinition(inst.definition);
      if (!def) continue;
      const conn = new UpstreamConnection(inst, def);
      conn.onStateChange = () => this.onConnStateChange();
      this.connections.set(inst.id, conn);
      try {
        await conn.connect();
      } catch {
        // keep the connection object so status reports the error + supervisor retries
      }
    }

    this.rebuildRoutes();
    this.activeProfileId = resolution.profileId;
    this.opts.onActivate?.(resolution, instances);
    this.notifyToolsChanged();

    // Drain-close removed connections in the background; routes already exclude them.
    for (const conn of toClose) void conn.close();
  }

  /** A connection dropped or recovered on its own — re-route and notify. */
  private onConnStateChange(): void {
    this.rebuildRoutes();
    this.notifyToolsChanged();
  }

  /**
   * Supervise connections: retry any that are down once their backoff elapses,
   * so a crashed upstream (or one that was down at activation) recovers without
   * a client restart.
   */
  private startSupervisor(): void {
    const interval = Number(process.env.HARBOR_SUPERVISE_MS) || 4000;
    this.supervisor = setInterval(() => void this.superviseTick(), interval);
    this.supervisor.unref?.();
  }

  private async superviseTick(): Promise<void> {
    const now = Date.now();
    let recovered = false;
    for (const conn of this.connections.values()) {
      if (conn.status !== "connected" && !conn.isConnecting && now >= conn.nextRetryAt) {
        try {
          await conn.connect();
          recovered = true;
        } catch {
          /* still down; backoff already scheduled */
        }
      }
    }
    if (recovered) this.onConnStateChange();
  }

  /**
   * Notify the client the tool set changed. The notification rejects
   * asynchronously before a transport attaches, so swallow that rejection.
   */
  private notifyToolsChanged(): void {
    try {
      Promise.resolve(this.server.sendToolListChanged?.()).catch(() => {});
    } catch {
      /* not connected yet */
    }
  }

  /**
   * Recompute the exposed tool set and the routing map. When `alwaysPrefix` is
   * on, every tool is namespaced (`supabase_prod__query`). When off, a tool is
   * exposed bare unless the same name is offered by more than one instance, in
   * which case only the colliding ones are prefixed — so agents get clean names
   * where unambiguous and disambiguated names where they'd otherwise clash.
   */
  private rebuildRoutes(): void {
    this.toolRoutes.clear();
    this.exposedTools = [];
    this.resourceOwners.clear();
    this.promptRoutes.clear();

    // Collect the tools visible after read-only filtering.
    const visible: Array<{ inst: Instance; tool: UpstreamTool }> = [];
    const nameCounts = new Map<string, number>();
    for (const conn of this.connections.values()) {
      if (conn.status !== "connected") continue;
      for (const tool of conn.tools) {
        if (isFilteredByReadonly(conn.instance, tool)) continue;
        if (isFilteredByToolPolicy(conn.instance, tool.name)) continue; // per-instance allow/deny
        visible.push({ inst: conn.instance, tool });
        nameCounts.set(tool.name, (nameCounts.get(tool.name) ?? 0) + 1);
      }
    }

    for (const { inst, tool } of visible) {
      const collides = (nameCounts.get(tool.name) ?? 0) > 1;
      let name = this.alwaysPrefix || collides ? namespacedName(inst, tool.name) : tool.name;
      // Never let two routes share a name; fall back to the namespaced form.
      if (this.toolRoutes.has(name)) name = namespacedName(inst, tool.name);
      this.toolRoutes.set(name, { instanceId: inst.id, originalName: tool.name });
      this.exposedTools.push({
        name,
        description: this.decorate(inst, tool.description),
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      });
    }
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: this.exposedTools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const exposed = req.params.name;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const route = this.toolRoutes.get(exposed);
      if (!route) {
        return this.errorResult(`unknown tool: ${exposed}`);
      }
      const conn = this.connections.get(route.instanceId);
      if (!conn || conn.status !== "connected") {
        return this.errorResult(`instance ${route.instanceId} is not connected`);
      }
      const inst = conn.instance;
      const tool = conn.tools.find((t) => t.name === route.originalName);
      const started = Date.now();

      // Filesystem scoping.
      const scopeErr = checkFilesystemScope(inst, args);
      if (scopeErr) {
        this.audit(inst, route.originalName, exposed, args, "blocked", scopeErr, started);
        return this.errorResult(scopeErr);
      }

      // Confirmation gate for writes on flagged instances.
      if (tool && requiresConfirmation(inst, { name: tool.name, annotations: tool.annotations })) {
        const approved = this.opts.approve
          ? await this.opts.approve({ instance: inst, tool: route.originalName, args, client: this.opts.client })
          : false;
        if (!approved) {
          this.audit(inst, route.originalName, exposed, args, "denied", "write not approved", started);
          return this.errorResult(
            `Write to "${inst.label}" requires approval and was not confirmed. ` +
              `Approve it in Harbor (or set HARBOR_AUTO_APPROVE=1).`,
          );
        }
      }

      try {
        const result = await conn.callTool(route.originalName, args);
        const size = JSON.stringify(result?.content ?? "").length;
        this.audit(inst, route.originalName, exposed, args, "ok", undefined, started, size);
        return result;
      } catch (err: any) {
        this.audit(inst, route.originalName, exposed, args, "error", err?.message, started);
        return this.errorResult(err?.message ?? String(err));
      }
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources: any[] = [];
      for (const conn of this.connections.values()) {
        if (conn.status !== "connected") continue;
        const { resources: rs } = await conn.listResources();
        for (const r of rs ?? []) {
          this.resourceOwners.set(r.uri, conn.instance.id);
          resources.push({ ...r, name: `${instancePrefix(conn.instance)}: ${r.name ?? r.uri}` });
        }
      }
      return { resources };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      const uri = req.params.uri;
      const ownerId = this.resourceOwners.get(uri);
      const conn = ownerId ? this.connections.get(ownerId) : undefined;
      if (!conn) throw new Error(`unknown resource: ${uri}`);
      return conn.readResource(uri);
    });

    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      const prompts: any[] = [];
      for (const conn of this.connections.values()) {
        if (conn.status !== "connected") continue;
        const { prompts: ps } = await conn.listPrompts();
        for (const p of ps ?? []) {
          const exposed = namespacedName(conn.instance, p.name);
          this.promptRoutes.set(exposed, { instanceId: conn.instance.id, originalName: p.name });
          prompts.push({ ...p, name: exposed });
        }
      }
      return { prompts };
    });

    this.server.setRequestHandler(GetPromptRequestSchema, async (req) => {
      const route = this.promptRoutes.get(req.params.name);
      const conn = route ? this.connections.get(route.instanceId) : undefined;
      if (!route || !conn) throw new Error(`unknown prompt: ${req.params.name}`);
      return conn.getPrompt(route.originalName, req.params.arguments as Record<string, string> | undefined);
    });
  }

  private decorate(inst: Instance, description?: string): string {
    const tag = inst.production ? " [PRODUCTION]" : "";
    const ro = inst.readonly ? " [read-only]" : "";
    return `(${inst.label})${tag}${ro} ${description ?? ""}`.trim();
  }

  private errorResult(message: string) {
    return { content: [{ type: "text", text: `Harbor: ${message}` }], isError: true };
  }

  private audit(
    inst: Instance,
    tool: string,
    exposed: string,
    args: unknown,
    outcome: "ok" | "error" | "denied" | "blocked",
    detail?: string,
    started?: number,
    resultSize?: number,
  ): void {
    AuditLog.append({
      client: this.opts.client,
      instance: inst.id,
      tool,
      exposedTool: exposed,
      argsSummary: summarizeArgs(args),
      outcome,
      detail,
      resultSize,
      durationMs: started ? Date.now() - started : undefined,
    });
  }

  // ---- Live reload -------------------------------------------------------

  private watch(): void {
    const files = [configPath(), runtimePath()];
    try {
      fs.watch(harborHome(), { persistent: false }, (_event, filename) => {
        if (!filename) return;
        if (files.some((f) => f.endsWith(filename))) {
          clearTimeout(this.watchTimer);
          this.watchTimer = setTimeout(() => void this.reload(), 150);
        }
      });
    } catch {
      // fs.watch may be unavailable; fall back to a poll.
      setInterval(() => void this.reload(), 3000).unref?.();
    }
  }

  /** Snapshot of connection health for `harbor status`. */
  statusSnapshot() {
    return {
      profile: this.activeProfileId,
      instances: [...this.connections.values()].map((c) => ({
        id: c.instance.id,
        label: c.instance.label,
        color: c.instance.color,
        status: c.status,
        error: c.error,
        tools: c.tools.length,
        readonly: c.instance.readonly,
        production: c.instance.production,
      })),
    };
  }

  async close(): Promise<void> {
    clearTimeout(this.watchTimer);
    clearInterval(this.supervisor);
    for (const conn of this.connections.values()) await conn.close();
    this.connections.clear();
    await this.server.close();
  }
}
