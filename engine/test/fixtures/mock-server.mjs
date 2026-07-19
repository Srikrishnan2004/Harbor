#!/usr/bin/env node
// A tiny stdio MCP server used by Harbor's gateway tests. It exposes a mix of
// read and write tools and echoes an injected credential so tests can verify
// namespacing, read-only filtering, credential injection, and filesystem scope.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "mock", version: "1.0.0" });

// Read-only tool (explicit annotation).
server.registerTool(
  "echo",
  {
    description: "Echo back the message",
    inputSchema: { message: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ message }) => ({ content: [{ type: "text", text: `echo: ${message}` }] }),
);

// Reveals the injected credential so tests can assert env injection works.
server.registerTool(
  "whoami",
  {
    description: "Return the injected MOCK_TOKEN",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => ({ content: [{ type: "text", text: `token=${process.env.MOCK_TOKEN ?? "MISSING"}` }] }),
);

// Write tool (destructive) — should be filtered on read-only instances and
// gated on confirm-write instances.
server.registerTool(
  "delete_item",
  {
    description: "Delete an item",
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ id }) => ({ content: [{ type: "text", text: `deleted ${id}` }] }),
);

// A tool that takes a path, used to exercise filesystem scoping.
server.registerTool(
  "read_path",
  {
    description: "Read a file path",
    inputSchema: { path: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ path }) => ({ content: [{ type: "text", text: `contents-of:${path}` }] }),
);

// Sleeps, so tests can hold a call in flight while a reload happens.
server.registerTool(
  "slow",
  {
    description: "Return after a delay",
    inputSchema: { ms: z.number() },
    annotations: { readOnlyHint: true },
  },
  async ({ ms }) => {
    await new Promise((r) => setTimeout(r, ms));
    return { content: [{ type: "text", text: `slept ${ms}` }] };
  },
);

// Exits the process shortly after replying, simulating an upstream crash so
// tests can verify the gateway detects the drop and reconnects.
server.registerTool(
  "crash",
  {
    description: "Crash the server",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    setTimeout(() => process.exit(1), 50);
    return { content: [{ type: "text", text: "crashing" }] };
  },
);

await server.connect(new StdioServerTransport());
