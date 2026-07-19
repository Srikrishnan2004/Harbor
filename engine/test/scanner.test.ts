import { describe, it, expect, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { scanFolder } from "../src/core/scanner.js";
import { ConfigStore } from "../src/core/store.js";

let tree: string;

function writeMcp(dir: string, servers: Record<string, any>) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
}

beforeEach(() => {
  process.env.HARBOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-scan-home-"));
  process.env.HARBOR_VAULT = "file";
  tree = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-scan-tree-"));
});

describe("scanFolder", () => {
  it("finds projects, counts servers, and spots duplicates", () => {
    writeMcp(path.join(tree, "app-a"), { supabase: { command: "npx", args: ["-y", "s"] } });
    writeMcp(path.join(tree, "app-b"), { supabase: { command: "npx", args: ["-y", "s"] }, github: { command: "gh" } });
    // Ignored dirs should not be scanned.
    writeMcp(path.join(tree, "app-b", "node_modules", "pkg"), { junk: { command: "x" } });

    const report = scanFolder(tree);
    expect(report.summary.projects).toBe(2);
    expect(report.summary.servers).toBe(3);
    expect(report.summary.duplicates).toContainEqual({ name: "supabase", count: 2 });
    expect(report.projects.every((p) => !p.path.includes("node_modules"))).toBe(true);
  });

  it("flags a conflict when a bound project declares servers directly", () => {
    const projDir = path.join(tree, "bound-app");
    writeMcp(projDir, { supabase: { command: "npx", args: ["-y", "s"] } });

    const store = ConfigStore.load();
    store.upsertProfile({ id: "dev", name: "Dev", instances: [] } as any);
    store.setBinding({ scope: "project", match: projDir, profile: "dev" });
    store.save();

    const report = scanFolder(tree);
    const bound = report.projects.find((p) => p.path === projDir)!;
    expect(bound.boundProfile).toBe("dev");
    expect(bound.conflict).toMatch(/declares 1 server/);
    expect(report.summary.conflicts).toBe(1);
  });

  it("counts a project routed through harbor as non-conflicting", () => {
    const projDir = path.join(tree, "good-app");
    writeMcp(projDir, { harbor: { command: "harbor", args: ["gateway", "--client", "claude-code"] } });
    const store = ConfigStore.load();
    store.upsertProfile({ id: "dev", name: "Dev", instances: [] } as any);
    store.setBinding({ scope: "project", match: projDir, profile: "dev" });
    store.save();

    const report = scanFolder(tree);
    expect(report.summary.usesHarbor).toBe(1);
    expect(report.summary.conflicts).toBe(0);
  });
});
