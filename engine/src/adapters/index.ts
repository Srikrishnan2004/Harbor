import os from "node:os";
import path from "node:path";
import { Adapter } from "./types.js";
import { JsonClientAdapter } from "./jsonClient.js";
import { CodexAdapter } from "./codex.js";

/**
 * The registry of client adapters. Add a new client here and it immediately
 * participates in `harbor setup`, `harbor scan`, `harbor import`, and status.
 *
 * Config paths default to each client's conventional location but can be
 * overridden per-client with an env var (e.g. HARBOR_ANTIGRAVITY_CONFIG) for
 * non-standard installs — useful where a client's real path differs by platform.
 */
export function allAdapters(): Adapter[] {
  const home = os.homedir();
  const override = (env: string, fallback: string) => process.env[env] || fallback;
  return [
    new JsonClientAdapter({
      id: "claude-code",
      displayName: "Claude Code",
      configPath: override("HARBOR_CLAUDE_CONFIG", path.join(home, ".claude.json")),
      projectConfigNames: [".mcp.json"],
    }),
    new CodexAdapter(override("HARBOR_CODEX_CONFIG", path.join(home, ".codex", "config.toml"))),
    new JsonClientAdapter({
      id: "gemini-cli",
      displayName: "Gemini CLI",
      configPath: override("HARBOR_GEMINI_CONFIG", path.join(home, ".gemini", "settings.json")),
      projectConfigNames: [".gemini/settings.json"],
      urlKey: "httpUrl",
    }),
    new JsonClientAdapter({
      id: "antigravity",
      displayName: "Antigravity",
      configPath: override("HARBOR_ANTIGRAVITY_CONFIG", path.join(home, ".antigravity", "settings.json")),
      projectConfigNames: [".antigravity/mcp.json"],
      urlKey: "url",
    }),
  ];
}

export function getAdapter(id: string): Adapter | undefined {
  return allAdapters().find((a) => a.id === id);
}

export * from "./types.js";
