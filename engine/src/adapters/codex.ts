import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Adapter, DiscoveredServer, HARBOR_ENTRY_NAME } from "./types.js";

/**
 * Codex stores MCP servers in `~/.codex/config.toml` under `[mcp_servers.NAME]`.
 * We avoid a full TOML dependency: a focused parser reads the `mcp_servers`
 * tables, and install/uninstall rewrite just Harbor's block, leaving the rest of
 * the file byte-for-byte intact.
 */
export class CodexAdapter implements Adapter {
  readonly id = "codex";
  readonly displayName = "Codex";
  readonly projectConfigNames: string[] = [];
  private path: string;

  constructor(configPath?: string) {
    this.path = configPath ?? path.join(os.homedir(), ".codex", "config.toml");
  }

  configPath(): string {
    return this.path;
  }

  detect(): boolean {
    return fs.existsSync(path.dirname(this.configPath()));
  }

  private text(): string {
    try {
      return fs.readFileSync(this.configPath(), "utf8");
    } catch {
      return "";
    }
  }

  readServers(file = this.configPath()): DiscoveredServer[] {
    let raw = "";
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return [];
    }
    const out: DiscoveredServer[] = [];
    // Split into [table.header] sections.
    const lines = raw.split("\n");
    let current: { name: string; fields: Record<string, string> } | null = null;
    const flush = () => {
      if (!current) return;
      const f = current.fields;
      const url = stripQuotes(f.url);
      out.push({
        name: current.name,
        source: this.id,
        transport: url ? "http" : "stdio",
        command: stripQuotes(f.command),
        args: parseTomlArray(f.args),
        url,
        env: undefined,
      });
      current = null;
    };
    for (const line of lines) {
      const header = line.match(/^\s*\[mcp_servers\.([^\]]+)\]\s*$/);
      if (header) {
        flush();
        current = { name: header[1].replace(/["']/g, ""), fields: {} };
        continue;
      }
      if (/^\s*\[/.test(line)) {
        flush();
        continue;
      }
      if (current) {
        const kv = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/);
        if (kv) current.fields[kv[1]] = kv[2];
      }
    }
    flush();
    return out;
  }

  isInstalled(): boolean {
    return new RegExp(`\\[mcp_servers\\.${HARBOR_ENTRY_NAME}\\]`).test(this.text());
  }

  private harborBlock(harborCommand: string): string {
    return (
      `[mcp_servers.${HARBOR_ENTRY_NAME}]\n` +
      `command = ${JSON.stringify(harborCommand)}\n` +
      `args = ["gateway", "--client", "${this.id}"]\n`
    );
  }

  install(harborCommand = "harbor"): boolean {
    const p = this.configPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let text = this.text();
    const block = this.harborBlock(harborCommand);
    const stripped = this.stripBlock(text);
    const next = (stripped.trimEnd() + "\n\n" + block).replace(/^\n+/, "");
    if (next === text) return false;
    fs.writeFileSync(p, next);
    return true;
  }

  uninstall(): boolean {
    const text = this.text();
    if (!this.isInstalled()) return false;
    fs.writeFileSync(this.configPath(), this.stripBlock(text).trimEnd() + "\n");
    return true;
  }

  /** Remove an existing [mcp_servers.harbor] block (and its keys) from the text. */
  private stripBlock(text: string): string {
    const lines = text.split("\n");
    const out: string[] = [];
    let skipping = false;
    for (const line of lines) {
      if (new RegExp(`^\\s*\\[mcp_servers\\.${HARBOR_ENTRY_NAME}\\]\\s*$`).test(line)) {
        skipping = true;
        continue;
      }
      if (skipping) {
        if (/^\s*\[/.test(line)) skipping = false; // next table starts
        else continue; // drop the block's key/value lines
      }
      if (!skipping) out.push(line);
    }
    return out.join("\n");
  }
}

function stripQuotes(v?: string): string | undefined {
  if (v == null) return undefined;
  return v.replace(/^["']|["']$/g, "");
}

function parseTomlArray(v?: string): string[] | undefined {
  if (!v) return undefined;
  const m = v.match(/^\[(.*)\]$/s);
  if (!m) return undefined;
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}
