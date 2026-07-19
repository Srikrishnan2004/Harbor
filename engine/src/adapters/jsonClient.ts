import fs from "node:fs";
import path from "node:path";
import { Adapter, DiscoveredServer, HARBOR_ENTRY_NAME } from "./types.js";

/**
 * Base for clients that store MCP servers as JSON under a `mcpServers` object
 * (Claude Code, Gemini CLI, Antigravity). Differences between them are just the
 * config path and how a remote server's URL field is named.
 */
export class JsonClientAdapter implements Adapter {
  readonly id: string;
  readonly displayName: string;
  private path: string;
  readonly projectConfigNames: string[];

  constructor(opts: {
    id: string;
    displayName: string;
    configPath: string;
    projectConfigNames?: string[];
    /** Kept for readability of the registry; readServers already handles url/httpUrl/serverUrl. */
    urlKey?: string;
  }) {
    this.id = opts.id;
    this.displayName = opts.displayName;
    this.path = opts.configPath;
    this.projectConfigNames = opts.projectConfigNames ?? [];
  }

  configPath(): string {
    return this.path;
  }

  detect(): boolean {
    return fs.existsSync(this.path) || fs.existsSync(path.dirname(this.path));
  }

  private read(file: string): any {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  }

  private write(file: string, data: any): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  }

  readServers(file = this.path): DiscoveredServer[] {
    if (!fs.existsSync(file)) return [];
    const data = this.read(file);
    const servers = data?.mcpServers ?? {};
    const out: DiscoveredServer[] = [];
    for (const [name, raw] of Object.entries<any>(servers)) {
      if (!raw || typeof raw !== "object") continue;
      const url = raw.url ?? raw.httpUrl ?? raw.serverUrl;
      out.push({
        name,
        source: this.id,
        transport: url ? (raw.type === "sse" ? "sse" : "http") : "stdio",
        command: raw.command,
        args: raw.args,
        url,
        env: raw.env,
      });
    }
    return out;
  }

  isInstalled(): boolean {
    if (!fs.existsSync(this.path)) return false;
    const data = this.read(this.path);
    return !!data?.mcpServers?.[HARBOR_ENTRY_NAME];
  }

  install(harborCommand = "harbor"): boolean {
    const data = fs.existsSync(this.path) ? this.read(this.path) : {};
    data.mcpServers ??= {};
    const entry = {
      command: harborCommand,
      args: ["gateway", "--client", this.id],
    };
    const before = JSON.stringify(data.mcpServers[HARBOR_ENTRY_NAME]);
    data.mcpServers[HARBOR_ENTRY_NAME] = entry;
    if (before === JSON.stringify(entry)) return false;
    this.write(this.path, data);
    return true;
  }

  uninstall(): boolean {
    if (!fs.existsSync(this.path)) return false;
    const data = this.read(this.path);
    if (!data?.mcpServers?.[HARBOR_ENTRY_NAME]) return false;
    delete data.mcpServers[HARBOR_ENTRY_NAME];
    this.write(this.path, data);
    return true;
  }
}
