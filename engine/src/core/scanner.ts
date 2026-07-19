import fs from "node:fs";
import path from "node:path";
import { allAdapters, DiscoveredServer } from "../adapters/index.js";
import { ConfigStore } from "./store.js";
import { expandHome } from "./paths.js";

export interface ProjectScan {
  path: string;
  configFiles: string[];
  servers: DiscoveredServer[];
  boundProfile?: string;
  /** Servers declared directly in the repo instead of via the Harbor gateway. */
  conflict?: string;
}

export interface ScanReport {
  root: string;
  projects: ProjectScan[];
  summary: {
    projects: number;
    servers: number;
    usesHarbor: number;
    duplicates: Array<{ name: string; count: number }>;
    conflicts: number;
  };
}

const IGNORE = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "target",
  "dist",
  "build",
  ".next",
  ".cache",
]);

const PROJECT_CONFIG_FILES = [".mcp.json", ".gemini/settings.json", ".vscode/mcp.json", ".cursor/mcp.json"];

/** Read MCP servers declared in a repo-level config file. */
function readProjectConfig(file: string): DiscoveredServer[] {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const servers = data?.mcpServers ?? data?.servers ?? {};
    return Object.entries<any>(servers).map(([name, raw]) => {
      const url = raw?.url ?? raw?.httpUrl;
      return {
        name,
        source: path.basename(file),
        transport: url ? "http" : "stdio",
        command: raw?.command,
        args: raw?.args,
        url,
        env: raw?.env,
      } as DiscoveredServer;
    });
  } catch {
    return [];
  }
}

/**
 * Walk a directory tree and report which projects declare which MCP servers,
 * which are already bound to a Harbor profile, and where the two disagree.
 */
export function scanFolder(root: string, maxDepth = 5): ScanReport {
  const abs = path.resolve(expandHome(root));
  const store = ConfigStore.load();
  const projects: ProjectScan[] = [];
  const nameCounts = new Map<string, number>();

  const bindingsByPath = new Map(
    store.bindings
      .filter((b) => b.scope === "project" && b.match)
      .map((b) => [path.resolve(expandHome(b.match!)), b.profile]),
  );

  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const configFiles: string[] = [];
    for (const candidate of PROJECT_CONFIG_FILES) {
      const p = path.join(dir, candidate);
      if (fs.existsSync(p)) configFiles.push(p);
    }

    if (configFiles.length) {
      const servers = configFiles.flatMap(readProjectConfig);
      const boundProfile = bindingsByPath.get(path.resolve(dir));
      let conflict: string | undefined;
      const nonHarbor = servers.filter((s) => s.name !== "harbor");
      if (boundProfile && nonHarbor.length) {
        conflict = `bound to "${boundProfile}" but declares ${nonHarbor.length} server(s) directly`;
      }
      for (const s of servers) nameCounts.set(s.name, (nameCounts.get(s.name) ?? 0) + 1);
      projects.push({ path: dir, configFiles, servers, boundProfile, conflict });
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !IGNORE.has(entry.name) && !entry.name.startsWith(".")) {
        walk(path.join(dir, entry.name), depth + 1);
      }
    }
  };

  walk(abs, 0);

  const duplicates = [...nameCounts.entries()]
    .filter(([, c]) => c > 1)
    .map(([name, count]) => ({ name, count }));

  return {
    root: abs,
    projects,
    summary: {
      projects: projects.length,
      servers: projects.reduce((n, p) => n + p.servers.length, 0),
      usesHarbor: projects.filter((p) => p.servers.some((s) => s.name === "harbor")).length,
      duplicates,
      conflicts: projects.filter((p) => p.conflict).length,
    },
  };
}

/** Scan every known client's user-level config for declared servers. */
export function scanClients(): DiscoveredServer[] {
  const out: DiscoveredServer[] = [];
  for (const adapter of allAdapters()) {
    if (!adapter.detect()) continue;
    out.push(...adapter.readServers());
  }
  return out;
}
