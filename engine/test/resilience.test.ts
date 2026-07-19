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

function seed(instances: string[]) {
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
  store.upsertInstance(Instance.parse({ id: "mock-rw", definition: "mock", label: "RW", color: "green" }));
  store.upsertInstance(Instance.parse({ id: "mock-2", definition: "mock", label: "Two", color: "blue" }));
  store.upsertProfile({ id: "test", name: "Test", instances } as any);
  store.settings.defaultProfile = "test";
  store.save();
}

beforeEach(() => {
  process.env.HARBOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-res-"));
  process.env.HARBOR_VAULT = "file";
  process.env.HARBOR_SUPERVISE_MS = "500"; // fast reconnect for tests
});

afterEach(async () => {
  await client?.close();
  await gateway?.close();
  delete process.env.HARBOR_SUPERVISE_MS;
});

async function connect() {
  gateway = new HarborGateway({ client: "test", cwd: "/tmp" });
  await gateway.start();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await gateway.server.connect(st);
  client = new Client({ name: "t", version: "1" });
  await client.connect(ct);
}

describe("connection resiliency", () => {
  it("detects an upstream crash and reconnects it", async () => {
    seed(["mock-rw"]);
    await connect();
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);

    // Crash the upstream; its process exits ~50ms later.
    await client.callTool({ name: "mock_rw__crash", arguments: {} }).catch(() => {});

    // Shortly after, the gateway should see the drop: tools disappear.
    await waitFor(async () => (await client.listTools()).tools.length === 0, 4000);
    expect(gateway.statusSnapshot().instances[0].status).not.toBe("connected");

    // The supervisor should reconnect a fresh process and restore the tools.
    await waitFor(async () => (await client.listTools()).tools.length > 0, 8000);
    expect(gateway.statusSnapshot().instances[0].status).toBe("connected");
  }, 20000);
});

describe("reload safety", () => {
  it("lets an in-flight call finish while its instance is removed from the profile", async () => {
    seed(["mock-rw", "mock-2"]);
    await connect();

    // Start a slow call, then remove mock-rw from the active profile mid-flight.
    const slow = client.callTool({ name: "mock_rw__slow", arguments: { ms: 500 } });
    await new Promise((r) => setTimeout(r, 80));
    const store = ConfigStore.load();
    store.upsertProfile({ id: "test", name: "Test", instances: ["mock-2"] } as any);
    store.save();

    // The drain-on-close means the in-flight call still resolves successfully.
    const res = (await slow) as any;
    expect(res.content[0].text).toBe("slept 500");

    // And after the switch settles, mock-rw's tools are gone.
    await waitFor(async () => {
      const names = (await client.listTools()).tools.map((t) => t.name);
      return names.some((n) => n.startsWith("mock_2__")) && !names.some((n) => n.startsWith("mock_rw__"));
    }, 4000);
  }, 20000);
});

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("condition not met within timeout");
}
