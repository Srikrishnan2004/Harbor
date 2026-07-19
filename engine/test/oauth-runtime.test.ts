import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ConfigStore } from "../src/core/store.js";
import { Instance, ServerDefinition } from "../src/core/types.js";
import { HarborOAuthProvider } from "../src/core/oauth.js";
import { HarborGateway } from "../src/mcp/gateway.js";

/**
 * Runtime OAuth path: an instance whose OAuth tokens are already in the vault
 * (as if consent completed) should have the gateway attach `Authorization:
 * Bearer <access_token>` automatically and connect. This is the daily-driver
 * path — the interactive consent flow is unit-tested separately.
 */
const ACCESS = "vault-access-token";
let httpServer: http.Server;
let httpUrl: string;
let gateway: HarborGateway;
let client: Client;

async function startBearerServer(): Promise<{ url: string; server: http.Server }> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${ACCESS}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    let body = "";
    req.on("data", (c) => (body += c));
    await new Promise<void>((r) => req.on("end", () => r()));
    const parsed = body ? JSON.parse(body) : undefined;
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let transport = sid ? transports.get(sid) : undefined;
    if (!transport && isInitializeRequest(parsed)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport!);
        },
      });
      const mcp = new McpServer({ name: "oauth-mock", version: "1.0.0" });
      mcp.registerTool(
        "whoami",
        { description: "who", inputSchema: {}, annotations: { readOnlyHint: true } },
        async () => ({ content: [{ type: "text", text: "authorized-via-oauth" }] }),
      );
      await mcp.connect(transport);
    }
    if (!transport) {
      res.writeHead(400);
      return res.end();
    }
    await transport.handleRequest(req, res, parsed);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as any).port}/mcp`, server };
}

beforeAll(async () => {
  process.env.HARBOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-oauthrt-"));
  process.env.HARBOR_VAULT = "file";
  const started = await startBearerServer();
  httpServer = started.server;
  httpUrl = started.url;

  const store = ConfigStore.load();
  store.upsertDefinition(
    ServerDefinition.parse({
      id: "oauth-remote",
      name: "OAuth Remote",
      transport: "http",
      url: httpUrl,
      credentials: [{ key: "Authorization", type: "secret", required: true, as: "header" }],
    }),
  );
  store.upsertInstance(
    Instance.parse({ id: "oauth-1", definition: "oauth-remote", label: "OAuth 1", authMode: "oauth" }),
  );
  store.upsertProfile({ id: "test", name: "Test", instances: ["oauth-1"] } as any);
  store.settings.defaultProfile = "test";
  store.save();

  // Simulate a completed consent flow: tokens already in the vault.
  const provider = new HarborOAuthProvider("oauth-1", { redirectUrl: "http://127.0.0.1:0/callback" });
  await provider.saveTokens({ access_token: ACCESS, token_type: "Bearer" } as any);

  gateway = new HarborGateway({ client: "test", cwd: "/tmp" });
  await gateway.start();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await gateway.server.connect(st);
  client = new Client({ name: "t", version: "1" });
  await client.connect(ct);
}, 30000);

afterAll(async () => {
  await client?.close();
  await gateway?.close();
  await new Promise<void>((r) => httpServer.close(() => r()));
});

describe("runtime OAuth", () => {
  it("connects using stored OAuth tokens (no static header credential set)", async () => {
    expect(gateway.statusSnapshot().instances[0].status).toBe("connected");
    const res = (await client.callTool({ name: "oauth_1__whoami", arguments: {} })) as any;
    expect(res.content[0].text).toBe("authorized-via-oauth");
  });
});
