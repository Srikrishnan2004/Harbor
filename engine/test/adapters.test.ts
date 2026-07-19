import { describe, it, expect, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { allAdapters, getAdapter } from "../src/adapters/index.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-adp-"));
  process.env.HARBOR_CLAUDE_CONFIG = path.join(tmp, ".claude.json");
  process.env.HARBOR_CODEX_CONFIG = path.join(tmp, "config.toml");
});

describe("JSON client adapter (Claude Code)", () => {
  it("installs only the harbor entry and preserves the rest", () => {
    const file = process.env.HARBOR_CLAUDE_CONFIG!;
    fs.writeFileSync(
      file,
      JSON.stringify({ numStartups: 3, mcpServers: { existing: { command: "npx", args: ["-y", "x"] } } }),
    );
    const a = getAdapter("claude-code")!;
    expect(a.isInstalled()).toBe(false);
    expect(a.install()).toBe(true);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(data.numStartups).toBe(3); // preserved
    expect(data.mcpServers.existing).toBeTruthy(); // preserved
    expect(data.mcpServers.harbor.args).toEqual(["gateway", "--client", "claude-code"]);
    expect(a.isInstalled()).toBe(true);

    // readServers surfaces both.
    expect(a.readServers().map((s) => s.name).sort()).toEqual(["existing", "harbor"]);

    // Idempotent + surgical uninstall.
    expect(a.install()).toBe(false);
    expect(a.uninstall()).toBe(true);
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(after.mcpServers.harbor).toBeUndefined();
    expect(after.mcpServers.existing).toBeTruthy();
  });

  it("detects remote servers via url/httpUrl", () => {
    const file = process.env.HARBOR_CLAUDE_CONFIG!;
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp" } } }));
    const servers = getAdapter("claude-code")!.readServers();
    expect(servers[0]).toMatchObject({ name: "sentry", transport: "http", url: "https://mcp.sentry.dev/mcp" });
  });
});

describe("Codex TOML adapter", () => {
  it("installs/uninstalls surgically and parses mcp_servers tables", () => {
    const file = process.env.HARBOR_CODEX_CONFIG!;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `model = "gpt-5"\n\n[mcp_servers.existing]\ncommand = "npx"\nargs = ["-y", "some-server"]\n`,
    );
    const a = getAdapter("codex")!;
    expect(a.readServers().map((s) => s.name)).toEqual(["existing"]);
    expect(a.isInstalled()).toBe(false);

    expect(a.install()).toBe(true);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain('model = "gpt-5"'); // preserved
    expect(text).toContain("[mcp_servers.existing]"); // preserved
    expect(text).toMatch(/\[mcp_servers\.harbor\][\s\S]*gateway/);
    expect(a.isInstalled()).toBe(true);

    expect(a.uninstall()).toBe(true);
    const after = fs.readFileSync(file, "utf8");
    expect(after).not.toContain("[mcp_servers.harbor]");
    expect(after).toContain("[mcp_servers.existing]");
    expect(after).toContain('model = "gpt-5"');
  });
});

describe("adapter registry", () => {
  it("exposes all four clients", () => {
    expect(allAdapters().map((a) => a.id).sort()).toEqual(["antigravity", "claude-code", "codex", "gemini-cli"]);
  });
  it("honors config-path env overrides", () => {
    expect(getAdapter("codex")!.configPath()).toBe(process.env.HARBOR_CODEX_CONFIG);
    expect(getAdapter("claude-code")!.configPath()).toBe(process.env.HARBOR_CLAUDE_CONFIG);
  });
});
