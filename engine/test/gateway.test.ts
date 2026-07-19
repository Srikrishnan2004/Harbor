import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigStore } from "../src/core/store.js";
import { Instance, ServerDefinition } from "../src/core/types.js";
import { Vault } from "../src/core/vault.js";
import { AuditLog } from "../src/core/audit.js";
import { HarborGateway } from "../src/mcp/gateway.js";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const MOCK = path.join(here, "fixtures", "mock-server.mjs");

let gateway: HarborGateway;
let client: Client;

beforeAll(async () => {
  process.env.HARBOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-gw-"));
  process.env.HARBOR_VAULT = "file";
  delete process.env.HARBOR_AUTO_APPROVE;

  const store = ConfigStore.load();
  // A definition that launches the mock server and injects MOCK_TOKEN as env.
  store.upsertDefinition(
    ServerDefinition.parse({
      id: "mock",
      name: "Mock",
      transport: "stdio",
      command: process.execPath, // node
      args: [MOCK],
      credentials: [{ key: "MOCK_TOKEN", type: "secret", required: true, as: "env" }],
    }),
  );

  // Read/write instance with an injected token.
  const rwRef = await Vault.set("mock-rw", "MOCK_TOKEN", "token-rw");
  store.upsertInstance(
    Instance.parse({ id: "mock-rw", definition: "mock", label: "Mock RW", color: "green", credentials: { MOCK_TOKEN: rwRef } }),
  );

  // Read-only instance — write tools must be hidden.
  const roRef = await Vault.set("mock-ro", "MOCK_TOKEN", "token-ro");
  store.upsertInstance(
    Instance.parse({ id: "mock-ro", definition: "mock", label: "Mock RO", color: "yellow", readonly: true, credentials: { MOCK_TOKEN: roRef } }),
  );

  // Confirm-writes instance — write tools require approval.
  const cRef = await Vault.set("mock-confirm", "MOCK_TOKEN", "token-c");
  store.upsertInstance(
    Instance.parse({ id: "mock-confirm", definition: "mock", label: "Mock Confirm", color: "red", confirmWrites: true, production: true, credentials: { MOCK_TOKEN: cRef } }),
  );

  // Scoped instance — read_path outside root must be blocked.
  const sRef = await Vault.set("mock-scoped", "MOCK_TOKEN", "token-s");
  store.upsertInstance(
    Instance.parse({ id: "mock-scoped", definition: "mock", label: "Mock Scoped", root: "/home/allowed", credentials: { MOCK_TOKEN: sRef } }),
  );

  store.upsertProfile({ id: "test", name: "Test", instances: ["mock-rw", "mock-ro", "mock-confirm", "mock-scoped"] } as any);
  store.settings.defaultProfile = "test";
  store.save();
  AuditLog.clear();

  // Gateway with NO approver → confirm-writes should be denied.
  gateway = new HarborGateway({ client: "test-client", cwd: "/tmp" });
  await gateway.start();

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await gateway.server.connect(serverT);
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientT);
}, 30000);

afterAll(async () => {
  await client?.close();
  await gateway?.close();
});

describe("HarborGateway end-to-end", () => {
  it("aggregates and namespaces tools across instances", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("mock_rw__echo");
    expect(names).toContain("mock_rw__whoami");
    expect(names).toContain("mock_rw__delete_item");
    // read-only instance hides the write tool but keeps reads
    expect(names).toContain("mock_ro__echo");
    expect(names).not.toContain("mock_ro__delete_item");
  });

  it("injects per-instance credentials into the upstream", async () => {
    const rw = (await client.callTool({ name: "mock_rw__whoami", arguments: {} })) as any;
    expect(rw.content[0].text).toBe("token=token-rw");
    const ro = (await client.callTool({ name: "mock_ro__whoami", arguments: {} })) as any;
    expect(ro.content[0].text).toBe("token=token-ro");
  });

  it("routes read tool calls and records the audit log", async () => {
    const res = (await client.callTool({ name: "mock_rw__echo", arguments: { message: "hi" } })) as any;
    expect(res.content[0].text).toBe("echo: hi");
    const log = AuditLog.read(50);
    const entry = log.find((e) => e.instance === "mock-rw" && e.tool === "echo");
    expect(entry?.outcome).toBe("ok");
  });

  it("denies writes on confirm-write instances without approval", async () => {
    const res = (await client.callTool({ name: "mock_confirm__delete_item", arguments: { id: "42" } })) as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/requires approval/);
    const denied = AuditLog.read(50).find((e) => e.instance === "mock-confirm" && e.outcome === "denied");
    expect(denied).toBeTruthy();
  });

  it("blocks filesystem-scope violations", async () => {
    const res = (await client.callTool({ name: "mock_scoped__read_path", arguments: { path: "/etc/passwd" } })) as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/scope violation/);
    const ok = (await client.callTool({ name: "mock_scoped__read_path", arguments: { path: "/home/allowed/file.txt" } })) as any;
    expect(ok.content[0].text).toBe("contents-of:/home/allowed/file.txt");
  });

  it("reacts to a profile change with a live tool set", async () => {
    // Swap the active profile to one with only the read-only instance.
    const store = ConfigStore.load();
    store.upsertProfile({ id: "test", name: "Test", instances: ["mock-ro"] } as any);
    store.save();
    // Give the file watcher a moment, then re-list.
    await new Promise((r) => setTimeout(r, 600));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("mock_ro__echo");
    expect(names).not.toContain("mock_rw__echo");
  });
});
