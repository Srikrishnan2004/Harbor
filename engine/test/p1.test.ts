import { describe, it, expect, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { ConfigStore } from "../src/core/store.js";
import { Instance, ServerDefinition, keychainRef } from "../src/core/types.js";
import { reconcileProject } from "../src/core/reconcile.js";
import { exportManifest, syncManifest } from "../src/core/manifest.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-p1-"));
  process.env.HARBOR_HOME = home;
  process.env.HARBOR_VAULT = "file";
});

describe("reconcile", () => {
  it("imports a project's servers, rewrites .mcp.json, and binds a profile", () => {
    const projDir = path.join(home, "proj");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, ".mcp.json"),
      JSON.stringify({
        other: "keep-me",
        mcpServers: { gh: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "x" } } },
      }),
    );
    const store = ConfigStore.load();
    store.upsertProfile({ id: "dev", name: "Dev", instances: [] } as any);

    const r = reconcileProject(store, projDir, { profile: "dev" });
    expect(r.removed).toEqual(["gh"]);
    expect(r.imported.length).toBe(1);
    expect(r.boundProfile).toBe("dev");

    const rewritten = JSON.parse(fs.readFileSync(path.join(projDir, ".mcp.json"), "utf8"));
    expect(Object.keys(rewritten.mcpServers)).toEqual(["harbor"]);
    expect(rewritten.mcpServers.harbor.args).toEqual(["gateway", "--client", "claude-code"]);
    expect(rewritten.other).toBe("keep-me"); // preserved
    expect(ConfigStore.load().bindings.some((b) => b.profile === "dev")).toBe(true);
  });
});

describe("manifest export/sync", () => {
  function seed(): ConfigStore {
    const store = ConfigStore.load();
    store.upsertDefinition(
      ServerDefinition.parse({
        id: "custom",
        name: "Custom",
        transport: "stdio",
        command: "node",
        credentials: [
          { key: "API_KEY", type: "secret", required: true, as: "env" },
          { key: "REGION", type: "string", required: false, as: "env" },
        ],
      }),
    );
    store.upsertInstance(
      Instance.parse({
        id: "custom-prod",
        definition: "custom",
        label: "Custom Prod",
        credentials: { API_KEY: keychainRef("custom-prod", "API_KEY"), REGION: "us-east-1" },
      }),
    );
    store.upsertProfile({ id: "team", name: "Team", instances: ["custom-prod"] } as any);
    store.save();
    return store;
  }

  it("exports references only — never a secret value", () => {
    const store = seed();
    const manifest = exportManifest(store, { profileId: "team" });
    expect(manifest.definitions.map((d) => d.id)).toEqual(["custom"]);
    const inst = manifest.instances.find((i) => i.id === "custom-prod")!;
    // Secret + keychain refs stripped; non-secret config kept.
    expect(inst.credentials.API_KEY).toBeUndefined();
    expect(inst.credentials.REGION).toBe("us-east-1");
    expect(JSON.stringify(manifest)).not.toContain("keychain://");
  });

  it("omits built-in definitions (they exist everywhere)", () => {
    const store = ConfigStore.load();
    store.upsertInstance(Instance.parse({ id: "s1", definition: "supabase", label: "S1" }));
    store.upsertProfile({ id: "p", name: "P", instances: ["s1"] } as any);
    store.save();
    const manifest = exportManifest(store, { profileId: "p" });
    expect(manifest.definitions.length).toBe(0); // supabase is built-in
    expect(manifest.instances.map((i) => i.id)).toEqual(["s1"]);
  });

  it("syncs into a fresh library and flags secrets needing auth", () => {
    const source = seed();
    const manifest = exportManifest(source, { profileId: "team" });

    // Fresh library in a new home.
    process.env.HARBOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-p1b-"));
    const dest = ConfigStore.load();
    const result = syncManifest(dest, manifest);

    expect(result.definitions).toContain("custom");
    expect(result.instances).toContain("custom-prod");
    expect(result.profiles).toContain("team");
    expect(result.needsAuth).toEqual([{ instance: "custom-prod", keys: ["API_KEY"] }]);

    const reloaded = ConfigStore.load();
    expect(reloaded.getInstance("custom-prod")?.credentials.REGION).toBe("us-east-1");
  });

  it("does not clobber a teammate's existing credentials", () => {
    const source = seed();
    const manifest = exportManifest(source, { profileId: "team" });

    process.env.HARBOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-p1c-"));
    const dest = ConfigStore.load();
    // Teammate already has this instance with their own secret ref.
    dest.upsertInstance(
      Instance.parse({
        id: "custom-prod",
        definition: "custom",
        label: "Mine",
        credentials: { API_KEY: keychainRef("custom-prod", "API_KEY"), REGION: "eu-west-1" },
      }),
    );
    dest.upsertDefinition(source.getDefinition("custom")!);
    dest.save();

    const result = syncManifest(dest, manifest);
    // Existing instance keeps its own creds; not reported as newly added.
    expect(result.instances).not.toContain("custom-prod");
    expect(ConfigStore.load().getInstance("custom-prod")?.credentials.API_KEY).toContain("keychain://");
    expect(result.needsAuth.length).toBe(0);
  });
});
