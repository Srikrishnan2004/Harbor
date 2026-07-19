import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigStore } from "../src/core/store.js";
import { Instance, ServerDefinition } from "../src/core/types.js";
import { HarborGateway } from "../src/mcp/gateway.js";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const MOCK = path.join(here, "fixtures", "mock-server.mjs");

let gateway: HarborGateway;
let client: Client;

function baseStore(): ConfigStore {
  const store = ConfigStore.load();
  store.upsertDefinition(
    ServerDefinition.parse({
      id: "mock",
      name: "Mock",
      transport: "stdio",
      command: process.execPath,
      args: [MOCK],
      credentials: [],
    }),
  );
  return store;
}

async function connect() {
  gateway = new HarborGateway({ client: "t", cwd: "/tmp", approve: async () => true });
  await gateway.start();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await gateway.server.connect(st);
  client = new Client({ name: "t", version: "1" });
  await client.connect(ct);
}

beforeEach(() => {
  process.env.HARBOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-gx-"));
  process.env.HARBOR_VAULT = "file";
});
afterEach(async () => {
  await client?.close();
  await gateway?.close();
});

describe("conditional namespacing (alwaysPrefix = false)", () => {
  it("exposes tools bare when a single instance owns them", async () => {
    const store = baseStore();
    store.settings.alwaysPrefix = false;
    store.upsertInstance(Instance.parse({ id: "mock-solo", definition: "mock", label: "Solo" }));
    store.upsertProfile({ id: "test", name: "Test", instances: ["mock-solo"] } as any);
    store.settings.defaultProfile = "test";
    store.save();
    await connect();

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("echo"); // bare — no prefix
    expect(names).not.toContain("mock_solo__echo");

    const res = (await client.callTool({ name: "echo", arguments: { message: "hi" } })) as any;
    expect(res.content[0].text).toBe("echo: hi");
  });

  it("prefixes only the colliding tools when two instances clash", async () => {
    const store = baseStore();
    store.settings.alwaysPrefix = false;
    store.upsertInstance(Instance.parse({ id: "mock-a", definition: "mock", label: "A" }));
    store.upsertInstance(Instance.parse({ id: "mock-b", definition: "mock", label: "B" }));
    store.upsertProfile({ id: "test", name: "Test", instances: ["mock-a", "mock-b"] } as any);
    store.settings.defaultProfile = "test";
    store.save();
    await connect();

    const names = (await client.listTools()).tools.map((t) => t.name);
    // Both instances expose `echo`, so it collides → both prefixed, none bare.
    expect(names).not.toContain("echo");
    expect(names).toContain("mock_a__echo");
    expect(names).toContain("mock_b__echo");

    const res = (await client.callTool({ name: "mock_b__echo", arguments: { message: "x" } })) as any;
    expect(res.content[0].text).toBe("echo: x");
  });

  it("always prefixes when alwaysPrefix = true (default)", async () => {
    const store = baseStore();
    store.upsertInstance(Instance.parse({ id: "mock-solo", definition: "mock", label: "Solo" }));
    store.upsertProfile({ id: "test", name: "Test", instances: ["mock-solo"] } as any);
    store.settings.defaultProfile = "test";
    store.save();
    await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("mock_solo__echo");
    expect(names).not.toContain("echo");
  });
});

describe("tool allow/deny policy", () => {
  it("denylist hides matching tools (with glob)", async () => {
    const store = baseStore();
    store.upsertInstance(Instance.parse({ id: "mock-d", definition: "mock", label: "D", denyTools: ["delete_*", "crash"] }));
    store.upsertProfile({ id: "test", name: "Test", instances: ["mock-d"] } as any);
    store.settings.defaultProfile = "test";
    store.save();
    await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("mock_d__echo");
    expect(names).not.toContain("mock_d__delete_item"); // matched delete_*
    expect(names).not.toContain("mock_d__crash");
  });

  it("allowlist exposes only listed tools", async () => {
    const store = baseStore();
    store.upsertInstance(Instance.parse({ id: "mock-a", definition: "mock", label: "A", allowTools: ["echo", "whoami"] }));
    store.upsertProfile({ id: "test", name: "Test", instances: ["mock-a"] } as any);
    store.settings.defaultProfile = "test";
    store.save();
    await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["mock_a__echo", "mock_a__whoami"]);
  });

  it("a denied tool cannot be called even if requested directly", async () => {
    const store = baseStore();
    store.upsertInstance(Instance.parse({ id: "mock-d", definition: "mock", label: "D", denyTools: ["delete_item"] }));
    store.upsertProfile({ id: "test", name: "Test", instances: ["mock-d"] } as any);
    store.settings.defaultProfile = "test";
    store.save();
    await connect();
    const res = (await client.callTool({ name: "mock_d__delete_item", arguments: { id: "1" } })) as any;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/unknown tool/);
  });
});

describe("confirm-write approval (approved path)", () => {
  it("executes the write when the approver returns true", async () => {
    const store = baseStore();
    store.upsertInstance(
      Instance.parse({ id: "mock-c", definition: "mock", label: "C", confirmWrites: true }),
    );
    store.upsertProfile({ id: "test", name: "Test", instances: ["mock-c"] } as any);
    store.settings.defaultProfile = "test";
    store.save();
    await connect(); // approve hook returns true

    const res = (await client.callTool({ name: "mock_c__delete_item", arguments: { id: "9" } })) as any;
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe("deleted 9");
  });
});
