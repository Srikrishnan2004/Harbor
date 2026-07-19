import { describe, it, expect, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { sanitizePrefix, Instance } from "../src/core/types.js";
import { namespacedName, splitNamespaced, collisions } from "../src/core/namespace.js";
import { isWriteTool, checkFilesystemScope, isFilteredByReadonly } from "../src/core/safety.js";
import { ConfigStore } from "../src/core/store.js";
import { resolveProfile, setRuntimeOverride } from "../src/core/resolver.js";
import { Vault } from "../src/core/vault.js";
import { importServers } from "../src/core/importer.js";

function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-test-"));
  process.env.HARBOR_HOME = dir;
  return dir;
}

beforeEach(() => {
  tmpHome();
  delete process.env.HARBOR_PROFILE;
});

describe("namespace", () => {
  it("sanitizes ids into prefixes", () => {
    expect(sanitizePrefix("supabase-prod")).toBe("supabase_prod");
    expect(sanitizePrefix("client.A/thing")).toBe("client_A_thing");
  });

  it("round-trips namespaced tool names", () => {
    const inst = Instance.parse({ id: "supabase-prod", definition: "supabase", label: "P" });
    const name = namespacedName(inst, "query");
    expect(name).toBe("supabase_prod__query");
    expect(splitNamespaced(name)).toEqual({ prefix: "supabase_prod", tool: "query" });
  });

  it("detects collisions across instances", () => {
    const map = new Map([
      ["a", ["query", "list"]],
      ["b", ["query"]],
    ]);
    expect([...collisions(map).keys()]).toEqual(["query"]);
  });
});

describe("safety", () => {
  it("honors annotations first", () => {
    expect(isWriteTool({ name: "anything", annotations: { readOnlyHint: true } })).toBe(false);
    expect(isWriteTool({ name: "safe_read", annotations: { destructiveHint: true } })).toBe(true);
  });

  it("falls back to a name heuristic", () => {
    expect(isWriteTool({ name: "delete_item" })).toBe(true);
    expect(isWriteTool({ name: "create_table" })).toBe(true);
    expect(isWriteTool({ name: "list_tables" })).toBe(false);
    expect(isWriteTool({ name: "get_user" })).toBe(false);
  });

  it("filters write tools on read-only instances", () => {
    const inst = Instance.parse({ id: "p", definition: "d", label: "P", readonly: true });
    expect(isFilteredByReadonly(inst, { name: "delete_item" })).toBe(true);
    expect(isFilteredByReadonly(inst, { name: "list_items" })).toBe(false);
  });

  it("enforces filesystem scope", () => {
    const inst = Instance.parse({ id: "fs", definition: "filesystem", label: "FS", root: "/home/me/project" });
    expect(checkFilesystemScope(inst, { path: "/home/me/project/src/a.ts" })).toBeNull();
    expect(checkFilesystemScope(inst, { path: "/etc/passwd" })).toMatch(/scope violation/);
    expect(checkFilesystemScope(inst, { path: "../../etc/passwd" })).toMatch(/scope violation/);
  });
});

describe("store", () => {
  it("merges built-in definitions and persists user data", () => {
    const store = ConfigStore.load();
    expect(store.getDefinition("supabase")).toBeTruthy();
    store.upsertInstance(Instance.parse({ id: "x", definition: "supabase", label: "X" }));
    store.upsertProfile({ id: "p", name: "P", instances: ["x"] } as any);
    store.save();

    const reloaded = ConfigStore.load();
    expect(reloaded.getInstance("x")?.label).toBe("X");
    expect(reloaded.profileInstances("p").map((i) => i.id)).toEqual(["x"]);
  });

  it("removes an instance from profiles when deleted", () => {
    const store = ConfigStore.load();
    store.upsertInstance(Instance.parse({ id: "x", definition: "supabase", label: "X" }));
    store.upsertProfile({ id: "p", name: "P", instances: ["x"] } as any);
    store.removeInstance("x");
    expect(store.getProfile("p")?.instances).toEqual([]);
  });
});

describe("resolver", () => {
  function seed(): ConfigStore {
    const store = ConfigStore.load();
    store.upsertInstance(Instance.parse({ id: "x", definition: "supabase", label: "X" }));
    store.upsertProfile({ id: "global-p", name: "G", instances: ["x"] } as any);
    store.upsertProfile({ id: "project-p", name: "Pr", instances: ["x"] } as any);
    store.upsertProfile({ id: "client-p", name: "Cl", instances: ["x"] } as any);
    store.upsertProfile({ id: "override-p", name: "Ov", instances: ["x"] } as any);
    store.settings.defaultProfile = "global-p";
    store.setBinding({ scope: "project", match: "/home/me/app", profile: "project-p" });
    store.setBinding({ scope: "client", match: "gemini-cli", profile: "client-p" });
    store.save();
    return store;
  }

  it("prefers project binding over client and global", () => {
    const store = seed();
    expect(resolveProfile(store, { client: "gemini-cli", cwd: "/home/me/app/src" })).toMatchObject({
      profileId: "project-p",
      reason: "project",
    });
  });

  it("uses client binding when no project matches", () => {
    const store = seed();
    expect(resolveProfile(store, { client: "gemini-cli", cwd: "/tmp/elsewhere" })).toMatchObject({
      profileId: "client-p",
      reason: "client",
    });
  });

  it("falls back to the global default", () => {
    const store = seed();
    expect(resolveProfile(store, { client: "claude-code", cwd: "/tmp" })).toMatchObject({
      profileId: "global-p",
    });
  });

  it("honors an explicit runtime override above all", () => {
    const store = seed();
    setRuntimeOverride("override-p");
    expect(resolveProfile(store, { client: "gemini-cli", cwd: "/home/me/app" })).toMatchObject({
      profileId: "override-p",
      reason: "override",
    });
    setRuntimeOverride(null);
  });
});

describe("vault (file backend)", () => {
  it("stores and resolves secrets via keychain refs", async () => {
    process.env.HARBOR_VAULT = "file";
    const ref = await Vault.set("supabase-prod", "TOKEN", "s3cr3t");
    expect(ref).toContain("keychain://");
    expect(await Vault.resolve(ref)).toBe("s3cr3t");
    expect(await Vault.resolve("plain-value")).toBe("plain-value");
    expect(await Vault.has("supabase-prod", "TOKEN")).toBe(true);
  });
});

describe("importer", () => {
  it("creates definitions and instances, marking secrets for auth", () => {
    const store = ConfigStore.load();
    const result = importServers(store, [
      {
        name: "my-postgres",
        source: "claude-code",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-postgres"],
        env: { DATABASE_URL: "postgres://secret", LOG_LEVEL: "info" },
      },
    ]);
    expect(result.instancesCreated).toContain("my-postgres");
    const inst = store.getInstance("my-postgres")!;
    // Non-secret env kept inline; secret-looking env NOT imported as a value.
    expect(inst.credentials.LOG_LEVEL).toBe("info");
    expect(inst.credentials.DATABASE_URL).toBeUndefined();
  });
});
