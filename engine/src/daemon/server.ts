import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { ConfigStore } from "../core/store.js";
import { Vault } from "../core/vault.js";
import { Instance, keychainRef, Profile } from "../core/types.js";
import { resolveProfile, setRuntimeOverride } from "../core/resolver.js";
import { testInstance } from "../core/health.js";
import { scanFolder } from "../core/scanner.js";
import { importServers } from "../core/importer.js";
import { AuditLog } from "../core/audit.js";
import { allAdapters, getAdapter } from "../adapters/index.js";
import { instancePrefix } from "../core/namespace.js";
import { expandHome, harborHome } from "../core/paths.js";
import { clearDaemonInfo, originAllowed, tokenMatches, writeDaemonInfo } from "./auth.js";

/**
 * The Harbor control daemon: a localhost HTTP API that the desktop UI (and the
 * `harbor status` CLI) talk to, plus a registry of live gateway processes and an
 * approval queue for confirm-write gates. It serves the built React UI from
 * `dist/` when present.
 */

interface GatewayReg {
  client?: string;
  profile: string | null;
  instances: any[];
  lastSeen: number;
}

interface Approval {
  id: string;
  instance: string;
  label: string;
  tool: string;
  args: unknown;
  client?: string;
  createdAt: number;
  resolve: (approved: boolean) => void;
}

const gateways = new Map<string, GatewayReg>();
const approvals = new Map<string, Approval>();
let approvalSeq = 0;
let daemonToken = "";

/** Set CORS headers, reflecting only allowed (localhost) origins. */
function applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin as string | undefined;
  if (origin && originAllowed(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
  }
  res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, x-harbor-token, authorization");
}

/** True when the request carries the daemon token (header or bearer). */
function authorized(req: http.IncomingMessage): boolean {
  if (!daemonToken) return true; // token not established (shouldn't happen post-start)
  const header = (req.headers["x-harbor-token"] as string | undefined) ?? undefined;
  const bearer = (req.headers["authorization"] as string | undefined)?.replace(/^Bearer\s+/i, "");
  return tokenMatches(daemonToken, header ?? bearer);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function distDir(): string | null {
  // Resolve the built UI relative to this file: engine/src/daemon -> repo/dist
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const candidate = path.resolve(here, "../../../dist");
  return fs.existsSync(candidate) ? candidate : null;
}

function serveStatic(res: http.ServerResponse, pathname: string): boolean {
  const dir = distDir();
  if (!dir) return false;
  let rel = pathname === "/" ? "/index.html" : pathname;
  let file = path.join(dir, rel);
  if (!file.startsWith(dir)) return false;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(dir, "index.html"); // SPA fallback
  }
  if (!fs.existsSync(file)) return false;
  const ext = path.extname(file);
  const type =
    { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" }[ext] ??
    "application/octet-stream";
  if (ext === ".html") {
    // Inject the daemon token so the same-origin UI can authenticate. A
    // cross-origin page never receives this HTML, so it can't read the token.
    let html = fs.readFileSync(file, "utf8");
    const inject = `<script>window.__HARBOR_TOKEN__=${JSON.stringify(daemonToken)}</script>`;
    html = html.includes("</head>") ? html.replace("</head>", inject + "</head>") : inject + html;
    res.writeHead(200, { "content-type": type });
    res.end(html);
    return true;
  }
  res.writeHead(200, { "content-type": type });
  res.end(fs.readFileSync(file));
  return true;
}

export async function startDaemon(port: number): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url ?? "/", true);
    const pathname = parsed.pathname ?? "/";
    const method = req.method ?? "GET";

    applyCors(req, res);

    if (method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    try {
      if (pathname.startsWith("/api/")) {
        // Liveness probe — unauthenticated, no sensitive data.
        if (method === "GET" && pathname === "/api/health") {
          return json(res, 200, { ok: true, service: "harbor-daemon", pid: process.pid, vault: await Vault.backendName() });
        }
        const origin = req.headers.origin as string | undefined;
        if (!originAllowed(origin)) return json(res, 403, { error: "origin not allowed" });
        if (!authorized(req)) return json(res, 401, { error: "missing or invalid Harbor token" });
        return await handleApi(req, res, method, pathname, parsed.query);
      }
      if (serveStatic(res, pathname)) return;
      // No built UI: friendly message.
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<h1>Harbor daemon</h1><p>API is at <code>/api/*</code>. Build the UI with <code>pnpm build:ui</code> to serve it here.</p>`,
      );
    } catch (err: any) {
      json(res, 500, { error: err?.message ?? String(err) });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  // Establish the control token and advertise the running daemon to the CLI.
  const info = writeDaemonInfo(port);
  daemonToken = info.token;

  console.log(`Harbor daemon listening on http://127.0.0.1:${port}  (vault: ${await Vault.backendName()})`);
  console.log(`Home: ${harborHome()}`);
  console.log(`Control token written to ${harborHome()}/daemon.json (API requires it).`);

  const cleanup = () => {
    clearDaemonInfo();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Expire stale gateway registrations.
  setInterval(() => {
    const now = Date.now();
    for (const [k, g] of gateways) if (now - g.lastSeen > 15_000) gateways.delete(k);
  }, 5000).unref();

  return server;
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  pathname: string,
  query: url.UrlWithParsedQuery["query"],
): Promise<void> {
  const store = ConfigStore.load();
  const seg = pathname.split("/").filter(Boolean); // ["api", ...]
  const r = seg.slice(1); // strip "api"

  // GET /api/config
  if (method === "GET" && r[0] === "config") {
    return json(res, 200, {
      ...store.data,
      definitions: store.definitions,
      vault: await Vault.backendName(),
      home: harborHome(),
    });
  }

  // GET /api/definitions
  if (method === "GET" && r[0] === "definitions") {
    return json(res, 200, store.definitions);
  }

  // Registry: GET /api/registry/search?q= ; POST /api/registry/install
  if (r[0] === "registry") {
    const reg = await import("../core/registry-client.js");
    if (method === "GET" && r[1] === "search") {
      const q = String(query.q ?? "");
      const limit = parseInt(String(query.limit ?? "15"), 10);
      try {
        return json(res, 200, await reg.searchRegistry(q, limit));
      } catch (e: any) {
        return json(res, 502, { error: e?.message ?? "registry unreachable" });
      }
    }
    if (method === "POST" && r[1] === "install") {
      const body = await readBody(req);
      try {
        const result = await reg.installFromRegistry(store, body.name, { id: body.id });
        store.save();
        return json(res, 200, result);
      } catch (e: any) {
        return json(res, 400, { error: e?.message ?? "install failed" });
      }
    }
  }

  // Instances
  if (r[0] === "instances") {
    if (method === "GET" && !r[1]) return json(res, 200, store.instances);
    if (method === "POST" && !r[1]) {
      const body = await readBody(req);
      const inst = Instance.parse(body);
      store.upsertInstance(inst);
      store.save();
      return json(res, 200, inst);
    }
    if (method === "DELETE" && r[1]) {
      store.removeInstance(r[1]);
      store.save();
      return json(res, 200, { ok: true });
    }
    if (method === "POST" && r[1] && r[2] === "auth") {
      const body = await readBody(req);
      const inst = store.getInstance(r[1]);
      if (!inst) return json(res, 404, { error: "no such instance" });
      await Vault.set(r[1], body.key, body.value);
      inst.credentials[body.key] = keychainRef(r[1], body.key);
      store.upsertInstance(inst);
      store.save();
      return json(res, 200, { ok: true });
    }
    if (method === "POST" && r[1] && r[2] === "test") {
      return json(res, 200, await testInstance(store, r[1]));
    }
    if (method === "POST" && r[1] && r[2] === "oauth") {
      const inst = store.getInstance(r[1]);
      const def = inst && store.getDefinition(inst.definition);
      if (!inst || !def || !def.url || def.transport === "stdio") {
        return json(res, 400, { error: "OAuth is only for remote (http/sse) instances" });
      }
      inst.authMode = "oauth";
      store.upsertInstance(inst);
      store.save();
      const { runOAuth } = await import("../core/oauth.js");
      const result = await runOAuth(def.url, r[1], def.transport === "sse" ? "sse" : "http");
      return json(res, 200, result);
    }
  }

  // Profiles
  if (r[0] === "profiles") {
    if (method === "GET" && !r[1]) return json(res, 200, store.profiles);
    if (method === "POST" && !r[1]) {
      const body = await readBody(req);
      const p = Profile.parse(body);
      store.upsertProfile(p);
      store.save();
      return json(res, 200, p);
    }
    if (method === "DELETE" && r[1]) {
      store.removeProfile(r[1]);
      store.save();
      return json(res, 200, { ok: true });
    }
  }

  // POST /api/activate {profileId}
  if (method === "POST" && r[0] === "activate") {
    const body = await readBody(req);
    if (body.profileId && !store.getProfile(body.profileId)) return json(res, 404, { error: "no such profile" });
    store.settings.defaultProfile = body.profileId || undefined;
    store.save();
    setRuntimeOverride(null);
    return json(res, 200, { ok: true, active: body.profileId ?? null });
  }

  // Bindings
  if (method === "POST" && r[0] === "bind") {
    const body = await readBody(req);
    store.setBinding({ scope: body.scope ?? "project", match: body.match ? path.resolve(expandHome(body.match)) : undefined, profile: body.profile });
    store.save();
    return json(res, 200, { ok: true });
  }
  if (method === "POST" && r[0] === "unbind") {
    const body = await readBody(req);
    store.removeBinding(body.scope ?? "project", body.match ? path.resolve(expandHome(body.match)) : undefined);
    store.save();
    return json(res, 200, { ok: true });
  }

  // GET /api/scan?dir=
  if (method === "GET" && r[0] === "scan") {
    const dir = String(query.dir ?? process.cwd());
    return json(res, 200, scanFolder(dir));
  }

  // POST /api/import {path|client}
  if (method === "POST" && r[0] === "import") {
    const body = await readBody(req);
    let servers;
    if (body.client) {
      const adapter = getAdapter(body.client);
      servers = adapter?.readServers() ?? [];
    } else {
      servers = scanFolder(body.path ?? process.cwd(), 2).projects.flatMap((p) => p.servers);
    }
    const result = importServers(store, servers, { colorCycle: true });
    store.save();
    return json(res, 200, result);
  }

  // POST /api/reconcile {path, profile?, client?}
  if (method === "POST" && r[0] === "reconcile") {
    const body = await readBody(req);
    const { reconcileProject } = await import("../core/reconcile.js");
    const result = reconcileProject(store, body.path, { profile: body.profile, client: body.client });
    return json(res, 200, result);
  }

  // GET /api/audit?limit=
  if (method === "GET" && r[0] === "audit") {
    const limit = parseInt(String(query.limit ?? "100"), 10);
    return json(res, 200, AuditLog.read(limit, { instance: query.instance as string | undefined, outcome: query.outcome as any }));
  }

  // GET /api/usage?since=24h&instance=
  if (method === "GET" && r[0] === "usage") {
    const { computeUsage, parseDuration } = await import("../core/analytics.js");
    const since = query.since ? parseDuration(String(query.since)) : null;
    return json(res, 200, computeUsage({ sinceMs: since ?? undefined, instance: query.instance as string | undefined }));
  }

  // GET /api/clients ; POST /api/setup
  if (method === "GET" && r[0] === "clients") {
    return json(
      res,
      200,
      allAdapters().map((a) => ({
        id: a.id,
        displayName: a.displayName,
        configPath: a.configPath(),
        detected: a.detect(),
        installed: a.isInstalled(),
      })),
    );
  }
  if (method === "POST" && r[0] === "setup") {
    const body = await readBody(req);
    const adapter = getAdapter(body.client);
    if (!adapter) return json(res, 404, { error: "no such client" });
    const changed = body.uninstall ? adapter.uninstall() : adapter.install(body.command ?? "harbor");
    return json(res, 200, { changed });
  }

  // GET /api/status — resolution per client + live gateways
  if (method === "GET" && r[0] === "status") {
    const cwd = String(query.cwd ?? process.cwd());
    const perClient = allAdapters().map((a) => {
      const resv = resolveProfile(store, { client: a.id, cwd });
      return { client: a.id, installed: a.isInstalled(), profile: resv.profileId, reason: resv.reason };
    });
    return json(res, 200, {
      perClient,
      gateways: [...gateways.values()],
      vault: await Vault.backendName(),
      profiles: store.profiles.map((p) => ({
        id: p.id,
        name: p.name,
        production: store.profileInstances(p.id).some((i) => i.production),
        instances: store.profileInstances(p.id).map((i) => ({ id: i.id, label: i.label, color: i.color, prefix: instancePrefix(i) })),
      })),
      active: store.settings.defaultProfile ?? null,
    });
  }

  // POST /api/gateways — gateway heartbeat/registration
  if (method === "POST" && r[0] === "gateways") {
    const body = await readBody(req);
    const key = body.client ?? "unknown";
    gateways.set(key, { client: body.client, profile: body.profile ?? null, instances: body.instances ?? [], lastSeen: Date.now() });
    return json(res, 200, { ok: true });
  }

  // Approvals: gateway POSTs and blocks; UI polls + resolves.
  if (r[0] === "approvals") {
    if (method === "POST" && !r[1]) {
      const body = await readBody(req);
      const id = `apr_${++approvalSeq}`;
      const approved = await new Promise<boolean>((resolve) => {
        const approval: Approval = { id, ...body, createdAt: Date.now(), resolve };
        approvals.set(id, approval);
        // Auto-deny after 55s so the gateway never hangs forever.
        setTimeout(() => {
          if (approvals.has(id)) {
            approvals.delete(id);
            resolve(false);
          }
        }, 55_000).unref();
      });
      return json(res, 200, { approved });
    }
    if (method === "GET" && r[1] === "pending") {
      return json(
        res,
        200,
        [...approvals.values()].map(({ resolve: _resolve, ...rest }) => rest),
      );
    }
    if (method === "POST" && r[1] && r[2] === "resolve") {
      const body = await readBody(req);
      const approval = approvals.get(r[1]);
      if (!approval) return json(res, 404, { error: "no such approval" });
      approval.resolve(!!body.approved);
      approvals.delete(r[1]);
      return json(res, 200, { ok: true });
    }
  }

  json(res, 404, { error: `no route: ${method} ${pathname}` });
}
