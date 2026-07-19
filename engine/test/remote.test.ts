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
import { z } from "zod";
import { ConfigStore } from "../src/core/store.js";
import { Instance, ServerDefinition } from "../src/core/types.js";
import { HarborGateway } from "../src/mcp/gateway.js";

/**
 * A real remote (HTTP) MCP server that requires a bearer token. Proves the
 * gateway's header credential injection works for remote transports end-to-end,
 * not just stdio.
 */
let httpServer: http.Server;
let httpUrl: string;
let gateway: HarborGateway;
let client: Client;
const TOKEN = "Bearer remote-secret";

async function startRemoteServer(): Promise<{ url: string; server: http.Server }> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== TOKEN) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    await new Promise<void>((r) => req.on("end", () => r()));
    const parsed = body ? JSON.parse(body) : undefined;

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport && isInitializeRequest(parsed)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport!);
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) transports.delete(transport!.sessionId);
      };
      const mcp = new McpServer({ name: "remote-mock", version: "1.0.0" });
      mcp.registerTool(
        "ping",
        { description: "ping", inputSchema: { msg: z.string() }, annotations: { readOnlyHint: true } },
        async ({ msg }) => ({ content: [{ type: "text", text: `pong: ${msg}` }] }),
      );
      await mcp.connect(transport);
    }

    if (!transport) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no session" }));
      return;
    }
    await transport.handleRequest(req, res, parsed);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}/mcp`, server };
}

beforeAll(async () => {
  process.env.HARBOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-remote-"));
  process.env.HARBOR_VAULT = "file";
  const started = await startRemoteServer();
  httpServer = started.server;
  httpUrl = started.url;

  const store = ConfigStore.load();
  store.upsertDefinition(
    ServerDefinition.parse({
      id: "remote",
      name: "Remote",
      transport: "http",
      url: httpUrl,
      credentials: [{ key: "Authorization", type: "secret", required: true, as: "header" }],
    }),
  );
  // Store the header value inline (resolves as a plain string).
  store.upsertInstance(
    Instance.parse({ id: "remote-1", definition: "remote", label: "Remote 1", credentials: { Authorization: TOKEN } }),
  );
  store.upsertProfile({ id: "test", name: "Test", instances: ["remote-1"] } as any);
  store.settings.defaultProfile = "test";
  store.save();

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

describe("remote HTTP transport", () => {
  it("connects to a token-protected remote server and injects the header", async () => {
    const snap = gateway.statusSnapshot();
    expect(snap.instances[0].status).toBe("connected");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("remote_1__ping");
  });

  it("routes a tool call through the remote server", async () => {
    const res = (await client.callTool({ name: "remote_1__ping", arguments: { msg: "hi" } })) as any;
    expect(res.content[0].text).toBe("pong: hi");
  });
});
