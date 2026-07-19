import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import {
  serverToDefinition,
  searchRegistry,
  installFromRegistry,
  RegistryServer,
} from "../src/core/registry-client.js";
import { ConfigStore } from "../src/core/store.js";

beforeEach(() => {
  process.env.HARBOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-reg-"));
  process.env.HARBOR_VAULT = "file";
});

describe("serverToDefinition", () => {
  it("maps an npm stdio package with env-var credentials", () => {
    const server: RegistryServer = {
      name: "io.github.acme/widget-mcp",
      title: "Widget",
      description: "Do widgets",
      packages: [
        {
          registryType: "npm",
          identifier: "widget-mcp",
          version: "2.1.0",
          transport: { type: "stdio" },
          environmentVariables: [
            { name: "WIDGET_TOKEN", isRequired: true, isSecret: true },
            { name: "WIDGET_REGION", isRequired: false },
          ],
        },
      ],
    };
    const def = serverToDefinition(server);
    expect(def.id).toBe("widget-mcp");
    expect(def.transport).toBe("stdio");
    expect(def.command).toBe("npx");
    expect(def.args).toEqual(["-y", "widget-mcp@2.1.0"]);
    const tokenCred = def.credentials.find((c) => c.key === "WIDGET_TOKEN");
    expect(tokenCred).toMatchObject({ type: "secret", required: true, as: "env" });
    expect(def.credentials.find((c) => c.key === "WIDGET_REGION")?.type).toBe("string");
  });

  it("maps a pypi package to uvx", () => {
    const def = serverToDefinition({
      name: "ai.example/tool",
      packages: [{ registryType: "pypi", identifier: "example-tool", version: "1.0.0", transport: { type: "stdio" } }],
    });
    expect(def.command).toBe("uvx");
    expect(def.args).toEqual(["example-tool==1.0.0"]);
  });

  it("maps a remote server with header credentials", () => {
    const def = serverToDefinition({
      name: "acme.io/remote",
      remotes: [{ type: "streamable-http", url: "https://mcp.acme.io", headers: [{ name: "Authorization", isRequired: true, isSecret: true }] }],
    });
    expect(def.transport).toBe("http");
    expect(def.url).toBe("https://mcp.acme.io");
    expect(def.credentials[0]).toMatchObject({ key: "Authorization", as: "header", type: "secret" });
  });

  it("throws when there is nothing installable", () => {
    expect(() => serverToDefinition({ name: "empty/thing" })).toThrow(/no installable/);
  });
});

describe("registry client against a mock server", () => {
  let server: http.Server;
  const SERVER: RegistryServer = {
    name: "io.github.acme/db-mcp",
    title: "DB",
    description: "database access",
    packages: [{ registryType: "npm", identifier: "db-mcp", version: "1.0.0", transport: { type: "stdio" }, environmentVariables: [{ name: "DB_URL", isRequired: true, isSecret: true }] }],
  };

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      if (req.url?.startsWith("/v0/servers")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ servers: [{ server: SERVER, _meta: {} }], metadata: { count: 1 } }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.HARBOR_REGISTRY_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterEach(async () => {
    delete process.env.HARBOR_REGISTRY_URL;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("searches and returns server records", async () => {
    const results = await searchRegistry("db", 5);
    expect(results[0].name).toBe("io.github.acme/db-mcp");
  });

  it("installs a registry server as a library definition", async () => {
    const store = ConfigStore.load();
    const { definition, created } = await installFromRegistry(store, "io.github.acme/db-mcp");
    expect(created).toBe(true);
    expect(definition.id).toBe("db-mcp");
    store.save();
    expect(ConfigStore.load().getDefinition("db-mcp")?.command).toBe("npx");
  });
});
