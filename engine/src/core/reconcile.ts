import fs from "node:fs";
import path from "node:path";
import { ConfigStore } from "./store.js";
import { importServers } from "./importer.js";
import { DiscoveredServer } from "../adapters/index.js";
import { expandHome } from "./paths.js";

export interface ReconcileResult {
  project: string;
  configFile: string;
  imported: string[];
  removed: string[];
  boundProfile?: string;
  changed: boolean;
}

/**
 * Reconcile a project's direct MCP config with Harbor: import whatever it
 * declares into the library (so nothing is lost), rewrite its `.mcp.json` to
 * route through the Harbor gateway instead, and optionally bind it to a profile.
 * This is the one-click fix for the red "conflict" cells in the project view.
 */
export function reconcileProject(
  store: ConfigStore,
  dir: string,
  opts: { profile?: string; client?: string; importFirst?: boolean } = {},
): ReconcileResult {
  const projectDir = path.resolve(expandHome(dir));
  const client = opts.client ?? "claude-code";
  const importFirst = opts.importFirst ?? true;
  const configFile = path.join(projectDir, ".mcp.json");

  let data: any = {};
  if (fs.existsSync(configFile)) {
    try {
      data = JSON.parse(fs.readFileSync(configFile, "utf8"));
    } catch {
      data = {};
    }
  }
  const servers: Record<string, any> = data.mcpServers ?? {};
  const directNames = Object.keys(servers).filter((n) => n !== "harbor");

  // Import the direct servers into the library so their config isn't lost.
  let imported: string[] = [];
  if (importFirst && directNames.length) {
    const discovered: DiscoveredServer[] = directNames.map((name) => {
      const raw = servers[name];
      const url = raw?.url ?? raw?.httpUrl;
      return {
        name,
        source: path.basename(configFile),
        transport: url ? "http" : "stdio",
        command: raw?.command,
        args: raw?.args,
        url,
        env: raw?.env,
      };
    });
    imported = importServers(store, discovered, { colorCycle: true }).instancesCreated;
  }

  // Rewrite so the repo routes through Harbor, preserving other top-level keys.
  data.mcpServers = {
    harbor: { command: "harbor", args: ["gateway", "--client", client] },
  };
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(data, null, 2) + "\n");

  // Bind the project to a profile if requested.
  let boundProfile: string | undefined;
  if (opts.profile && store.getProfile(opts.profile)) {
    store.setBinding({ scope: "project", match: projectDir, profile: opts.profile });
    boundProfile = opts.profile;
    store.save();
  }

  return {
    project: projectDir,
    configFile,
    imported,
    removed: directNames,
    boundProfile,
    changed: true,
  };
}
