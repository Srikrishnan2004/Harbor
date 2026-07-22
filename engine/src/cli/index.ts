#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { ConfigStore } from "../core/store.js";
import { Vault } from "../core/vault.js";
import { Instance, keychainRef, sanitizePrefix } from "../core/types.js";
import { resolveProfile, setRuntimeOverride } from "../core/resolver.js";
import { testInstance } from "../core/health.js";
import { scanFolder } from "../core/scanner.js";
import { importServers } from "../core/importer.js";
import { AuditLog } from "../core/audit.js";
import { allAdapters, getAdapter } from "../adapters/index.js";
import { instancePrefix } from "../core/namespace.js";
import { expandHome, harborHome } from "../core/paths.js";
import {
  bold,
  chip,
  c,
  dim,
  fail,
  heading,
  ok,
  printJson,
  prompt,
  statusDot,
  table,
  warn,
} from "./util.js";

const program = new Command();
program
  .name("harbor")
  .description("Store, credential, and switch MCP servers across every AI client.")
  .version("0.1.0");

function saveStore(fn: (store: ConfigStore) => void): void {
  const store = ConfigStore.load();
  fn(store);
  store.save();
}

// ---- Library: list ------------------------------------------------------

program
  .command("list")
  .alias("ls")
  .description("List all instances in the library")
  .option("--json", "output JSON")
  .option("--test", "live-connect each instance to report health")
  .action(async (opts) => {
    const store = ConfigStore.load();
    if (opts.json) return printJson(store.instances);
    if (!store.instances.length) {
      console.log(dim("No instances yet. Add one with `harbor add <definition>`."));
      console.log(dim("Definitions available: " + store.definitions.map((d) => d.id).join(", ")));
      return;
    }
    const rows: string[][] = [];
    for (const inst of store.instances) {
      let health = dim("—");
      if (opts.test) {
        const r = await testInstance(store, inst.id);
        health = r.ok ? c("green", `${r.tools.length} tools`) : c("red", r.error ?? "error");
      }
      rows.push([
        `${chip(inst.color)} ${bold(inst.id)}`,
        inst.label,
        dim(inst.definition),
        inst.readonly ? c("yellow", "read-only") : "",
        inst.production ? c("red", "PROD") : "",
        health,
      ]);
    }
    table(rows, { head: ["instance", "label", "definition", "", "", opts.test ? "health" : ""] });
  });

// ---- Library: definitions ----------------------------------------------

const def = program.command("def").description("Manage server definitions (templates)");
def
  .command("list")
  .alias("ls")
  .option("--json", "output JSON")
  .action((opts) => {
    const store = ConfigStore.load();
    if (opts.json) return printJson(store.definitions);
    table(
      store.definitions.map((d) => [
        bold(d.id),
        d.name,
        d.transport,
        d.builtin ? dim("built-in") : c("blue", "custom"),
        dim((d.credentials.map((cr) => cr.key).join(", ") || "no creds")),
      ]),
      { head: ["id", "name", "transport", "", "credentials"] },
    );
  });
def
  .command("add <id>")
  .description("Define a custom server template")
  .requiredOption("--name <name>", "display name")
  .option("--transport <t>", "stdio | sse | http", "stdio")
  .option("--command <cmd>", "launch command (stdio)")
  .option("--args <args>", "comma-separated args")
  .option("--url <url>", "server URL (http/sse)")
  .option("--cred <key...>", "credential key (repeatable); prefix with secret: to mark secret")
  .action((id, opts) => {
    saveStore((store) => {
      const credentials = (opts.cred ?? []).map((raw: string) => {
        const secret = raw.startsWith("secret:");
        const key = raw.replace(/^(secret|string):/, "");
        return { key, type: secret ? "secret" : "string", required: true, as: opts.transport === "stdio" ? "env" : "header" };
      });
      store.upsertDefinition({
        id,
        name: opts.name,
        transport: opts.transport,
        command: opts.command,
        args: opts.args ? String(opts.args).split(",").map((s: string) => s.trim()) : [],
        url: opts.url,
        env: {},
        credentials,
        tags: [],
        filesystemRoot: false,
        builtin: false,
      } as any);
      ok(`Defined server "${id}"`);
    });
  });

// ---- Registry (search / install) ---------------------------------------

program
  .command("search <query>")
  .description("Search the MCP registry for servers")
  .option("--limit <n>", "max results", "15")
  .option("--json", "output JSON")
  .action(async (query, opts) => {
    const { searchRegistry } = await import("../core/registry-client.js");
    try {
      const results = await searchRegistry(query, parseInt(opts.limit, 10) || 15);
      if (opts.json) return printJson(results);
      if (!results.length) return console.log(dim("No matches."));
      table(
        results.map((s) => {
          const kind = s.packages?.[0]?.registryType ?? (s.remotes?.length ? "remote" : "?");
          return [bold(s.name), dim(kind), (s.description ?? "").slice(0, 60)];
        }),
        { head: ["name", "type", "description"] },
      );
      console.log(dim("\nInstall one with: harbor install <name>"));
    } catch (e: any) {
      fail(e.message);
    }
  });

program
  .command("install <name>")
  .description("Install a registry server into your library")
  .option("--id <id>", "override the definition id")
  .option("--add", "also create an instance of it")
  .action(async (name, opts) => {
    const { installFromRegistry } = await import("../core/registry-client.js");
    const store = ConfigStore.load();
    try {
      const { definition, created } = await installFromRegistry(store, name, { id: opts.id });
      store.save();
      ok(`${created ? "Installed" : "Updated"} definition ${bold(definition.id)} (${definition.name})`);
      const secrets = definition.credentials.filter((c) => c.type === "secret").map((c) => c.key);
      if (secrets.length) console.log(dim(`  needs credentials: ${secrets.join(", ")}`));
      if (opts.add) {
        const instId = uniqueId(store, definition.id);
        store.upsertInstance(Instance.parse({ id: instId, definition: definition.id, label: definition.name }));
        store.save();
        ok(`Added instance ${bold(instId)}`);
        await reportHealth(store, instId);
        if (secrets.length) warn(`Set secrets with: harbor auth ${instId}`);
      } else {
        console.log(dim(`  add an instance: harbor add ${definition.id}`));
      }
    } catch (e: any) {
      fail(e.message);
    }
  });

// ---- Library: add / clone / rm -----------------------------------------

program
  .command("add <definition>")
  .description("Add an instance of a server definition")
  .option("--id <id>", "instance id")
  .option("--label <label>", "human label")
  .option("--color <color>", "gray|blue|green|yellow|orange|red|purple|pink|teal", "gray")
  .option("--readonly", "gateway hides write tools")
  .option("--confirm-writes", "writes require approval")
  .option("--production", "flag as production (drives warnings)")
  .option("--root <dir>", "scoped root for filesystem servers")
  .option("--allow <tool...>", "only expose these tools (exact name or * glob)")
  .option("--deny <tool...>", "always hide these tools (exact name or * glob)")
  .option("--set <kv...>", "set a non-secret credential KEY=VALUE")
  .option("--no-check", "skip the health check after creating")
  .action(async (definition, opts) => {
    const store = ConfigStore.load();
    const d = store.getDefinition(definition);
    if (!d) return fail(`No such definition "${definition}". See \`harbor def list\`.`);
    const id = opts.id ?? uniqueId(store, definition);
    if (store.getInstance(id)) return fail(`Instance "${id}" already exists.`);
    const credentials: Record<string, string> = {};
    for (const kv of opts.set ?? []) {
      const eq = String(kv).indexOf("=");
      if (eq > 0) credentials[String(kv).slice(0, eq)] = String(kv).slice(eq + 1);
    }
    const instance: Instance = Instance.parse({
      id,
      definition,
      label: opts.label ?? d.name,
      color: opts.color,
      readonly: !!opts.readonly,
      confirmWrites: !!opts.confirmWrites,
      production: !!opts.production,
      root: opts.root ? path.resolve(expandHome(opts.root)) : undefined,
      allowTools: opts.allow ?? [],
      denyTools: opts.deny ?? [],
      credentials,
    });
    store.upsertInstance(instance);
    store.save();
    ok(`Added instance ${chip(instance.color)} ${bold(id)} (${d.name})`);
    // Health check on creation — verify the server actually connects, like
    // validating a DB connection at setup. Skipped with --no-check.
    if (opts.check !== false) await reportHealth(store, id);
    const needsAuth = d.credentials.filter((cr) => cr.type === "secret" && !credentials[cr.key]);
    if (needsAuth.length) warn(`Set secrets with: harbor auth ${id}`);
  });

program
  .command("clone <instanceId>")
  .description("Clone an instance (same definition, fresh credentials)")
  .option("--id <id>", "new instance id")
  .option("--label <label>", "new label")
  .option("--color <color>", "color")
  .action((instanceId, opts) => {
    saveStore((store) => {
      const src = store.getInstance(instanceId);
      if (!src) return fail(`No such instance "${instanceId}".`);
      const id = opts.id ?? uniqueId(store, src.definition);
      if (store.getInstance(id)) return fail(`Instance "${id}" already exists.`);
      const clone: Instance = Instance.parse({
        ...src,
        id,
        label: opts.label ?? `${src.label} (copy)`,
        color: opts.color ?? src.color,
        credentials: { ...nonSecretCreds(store, src) },
      });
      store.upsertInstance(clone);
      ok(`Cloned ${bold(instanceId)} → ${chip(clone.color)} ${bold(id)}`);
      warn(`Set its own secrets with: harbor auth ${id}`);
    });
  });

program
  .command("rm <instanceId>")
  .alias("remove")
  .description("Remove an instance")
  .action((instanceId) => {
    saveStore((store) => {
      if (!store.getInstance(instanceId)) return fail(`No such instance "${instanceId}".`);
      store.removeInstance(instanceId);
      ok(`Removed instance "${instanceId}"`);
    });
  });

// ---- Auth / test --------------------------------------------------------

program
  .command("auth <instanceId> [key]")
  .description("Store a secret (or run the OAuth flow) for an instance")
  .option("--value <value>", "provide the secret non-interactively")
  .option("--oauth", "run the OAuth authorization flow instead of a static token")
  .action(async (instanceId, key, opts) => {
    const store = ConfigStore.load();
    const inst = store.getInstance(instanceId);
    if (!inst) return fail(`No such instance "${instanceId}".`);
    const d = store.getDefinition(inst.definition);
    if (!d) return fail(`Missing definition "${inst.definition}".`);

    if (opts.oauth) {
      if (d.transport === "stdio" || !d.url) return fail("OAuth is only for remote (http/sse) servers.");
      const { runOAuth } = await import("../core/oauth.js");
      inst.authMode = "oauth";
      store.upsertInstance(inst);
      store.save();
      warn(`Starting OAuth for ${d.name} — approve in the browser that opens.`);
      const result = await runOAuth(d.url, instanceId, d.transport === "sse" ? "sse" : "http", (m) => console.error(m));
      if (result.ok) ok(`OAuth complete — tokens stored (${await Vault.backendName()}).`);
      else fail(`OAuth failed: ${result.error}`);
      return;
    }

    const secretKeys = d.credentials.filter((cr) => cr.type === "secret").map((cr) => cr.key);
    const keys = key ? [key] : secretKeys;
    if (!keys.length) return warn("This definition declares no secret credentials.");
    for (const k of keys) {
      const value =
        opts.value ?? (await prompt(`${d.name} · ${k}: `, true));
      if (!value) {
        warn(`Skipped ${k} (empty).`);
        continue;
      }
      await Vault.set(instanceId, k, value);
      inst.credentials[k] = keychainRef(instanceId, k);
      ok(`Stored ${k} for "${instanceId}" (${await Vault.backendName()})`);
    }
    store.save();
  });

program
  .command("test <instanceId>")
  .description("Connect to an instance and list its tools")
  .option("--json", "output JSON")
  .action(async (instanceId, opts) => {
    const store = ConfigStore.load();
    const r = await testInstance(store, instanceId);
    if (opts.json) return printJson(r);
    if (r.ok) {
      ok(`${instanceId} connected in ${r.durationMs}ms — ${r.tools.length} tools`);
      if (r.tools.length) console.log(dim("  " + r.tools.join(", ")));
    } else {
      fail(`${instanceId}: ${r.error}`);
      process.exitCode = 1;
    }
  });

// ---- Profiles -----------------------------------------------------------

const profile = program.command("profile").description("Manage profiles");
profile
  .command("create <id>")
  .option("--name <name>", "display name")
  .option("--warn <message>", "warning shown on activate")
  .action((id, opts) => {
    saveStore((store) => {
      if (store.getProfile(id)) return fail(`Profile "${id}" already exists.`);
      store.upsertProfile({ id, name: opts.name ?? id, instances: [], warnOnActivate: opts.warn } as any);
      ok(`Created profile "${id}"`);
    });
  });
profile
  .command("add <id> <instances...>")
  .description("Add instances to a profile")
  .action((id, instances) => {
    saveStore((store) => {
      const p = store.getProfile(id);
      if (!p) return fail(`No such profile "${id}".`);
      for (const iid of instances) {
        if (!store.getInstance(iid)) {
          warn(`Skipping unknown instance "${iid}"`);
          continue;
        }
        if (!p.instances.includes(iid)) p.instances.push(iid);
      }
      store.upsertProfile(p);
      ok(`Profile "${id}" now has: ${p.instances.join(", ") || "(empty)"}`);
    });
  });
profile
  .command("rm <id> <instances...>")
  .description("Remove instances from a profile")
  .action((id, instances) => {
    saveStore((store) => {
      const p = store.getProfile(id);
      if (!p) return fail(`No such profile "${id}".`);
      p.instances = p.instances.filter((i) => !instances.includes(i));
      store.upsertProfile(p);
      ok(`Profile "${id}" now has: ${p.instances.join(", ") || "(empty)"}`);
    });
  });
profile
  .command("delete <id>")
  .description("Delete a profile")
  .action((id) => {
    saveStore((store) => {
      if (!store.removeProfile(id)) return fail(`No such profile "${id}".`);
      ok(`Deleted profile "${id}"`);
    });
  });
profile
  .command("list")
  .alias("ls")
  .option("--json", "output JSON")
  .action((opts) => {
    const store = ConfigStore.load();
    if (opts.json) return printJson(store.profiles);
    if (!store.profiles.length) return console.log(dim("No profiles yet."));
    const active = store.settings.defaultProfile;
    table(
      store.profiles.map((p) => [
        (p.id === active ? c("green", "▶ ") : "  ") + bold(p.id),
        p.name,
        dim(`${p.instances.length} instances`),
        p.warnOnActivate ? c("yellow", "⚠ warns") : "",
      ]),
      { head: ["profile", "name", "", ""] },
    );
  });
profile
  .command("show <id>")
  .option("--json", "output JSON")
  .action((id, opts) => {
    const store = ConfigStore.load();
    const p = store.getProfile(id);
    if (!p) return fail(`No such profile "${id}".`);
    if (opts.json) return printJson({ ...p, instances: store.profileInstances(id) });
    heading(`${p.name} (${p.id})`);
    if (p.warnOnActivate) warn(p.warnOnActivate);
    const insts = store.profileInstances(id);
    if (!insts.length) return console.log(dim("  (no enabled instances)"));
    table(
      insts.map((i) => [
        `${chip(i.color)} ${bold(i.id)}`,
        i.label,
        dim(instancePrefix(i) + "__*"),
        i.readonly ? c("yellow", "read-only") : "",
        i.production ? c("red", "PROD") : "",
      ]),
    );
  });
profile
  .command("use <id>")
  .description("Activate a profile as the global default")
  .action((id) => {
    saveStore((store) => {
      const p = store.getProfile(id);
      if (!p) return fail(`No such profile "${id}".`);
      const prod = store.profileInstances(id).filter((i) => i.production);
      if (p.warnOnActivate) warn(p.warnOnActivate);
      if (prod.length) warn(`This profile touches PRODUCTION: ${prod.map((i) => i.label).join(", ")}`);
      store.settings.defaultProfile = id;
      setRuntimeOverride(null);
      ok(`Active profile → ${bold(id)}. Live in every client immediately.`);
    });
  });

// ---- Bindings -----------------------------------------------------------

program
  .command("bind <path> <profile>")
  .description("Bind a profile to a project directory")
  .action((p, profileId) => {
    saveStore((store) => {
      if (!store.getProfile(profileId)) return fail(`No such profile "${profileId}".`);
      const abs = path.resolve(expandHome(p));
      store.setBinding({ scope: "project", match: abs, profile: profileId });
      ok(`Bound ${dim(abs)} → ${bold(profileId)}`);
    });
  });
program
  .command("bind-client <client> <profile>")
  .description("Bind a profile as a client's default")
  .action((client, profileId) => {
    saveStore((store) => {
      if (!store.getProfile(profileId)) return fail(`No such profile "${profileId}".`);
      store.setBinding({ scope: "client", match: client, profile: profileId });
      ok(`Client ${bold(client)} defaults to ${bold(profileId)}`);
    });
  });
program
  .command("unbind <path>")
  .description("Remove a project binding")
  .action((p) => {
    saveStore((store) => {
      const abs = path.resolve(expandHome(p));
      if (!store.removeBinding("project", abs)) return fail(`No binding for ${abs}.`);
      ok(`Unbound ${dim(abs)}`);
    });
  });

// ---- Scan / import ------------------------------------------------------

program
  .command("scan <dir>")
  .description("Find MCP config across a directory tree")
  .option("--report", "summarize counts, duplicates, and conflicts")
  .option("--json", "output JSON")
  .action((dir, opts) => {
    const report = scanFolder(dir);
    if (opts.json) return printJson(report);
    heading(`Scanned ${report.root}`);
    if (!report.projects.length) return console.log(dim("  No MCP config found."));
    for (const proj of report.projects) {
      const names = proj.servers.map((s) => (s.name === "harbor" ? c("green", "harbor") : s.name)).join(", ");
      console.log(`${proj.conflict ? c("red", "✗") : " "} ${bold(path.relative(report.root, proj.path) || ".")}  ${dim(names)}`);
      if (proj.boundProfile) console.log(dim(`    bound → ${proj.boundProfile}`));
      if (proj.conflict) console.log(c("red", `    conflict: ${proj.conflict}`));
    }
    if (opts.report) {
      heading("Summary");
      console.log(`  projects:   ${report.summary.projects}`);
      console.log(`  servers:    ${report.summary.servers}`);
      console.log(`  via harbor: ${report.summary.usesHarbor}`);
      console.log(`  conflicts:  ${report.summary.conflicts}`);
      if (report.summary.duplicates.length) {
        console.log(`  duplicates: ${report.summary.duplicates.map((d) => `${d.name}×${d.count}`).join(", ")}`);
      }
    }
  });

program
  .command("import [path]")
  .description("Import existing MCP config into the library")
  .option("--client <id>", "import from a client's user config instead of a path")
  .option("--dry-run", "show what would be imported")
  .action((p, opts) => {
    const store = ConfigStore.load();
    let servers;
    if (opts.client) {
      const adapter = getAdapter(opts.client);
      if (!adapter) return fail(`No such client "${opts.client}".`);
      servers = adapter.readServers();
    } else if (p) {
      const report = scanFolder(p, 2);
      servers = report.projects.flatMap((pr) => pr.servers);
    } else {
      return fail("Provide a path or --client <id>.");
    }
    if (!servers.length) return warn("Nothing to import.");
    if (opts.dryRun) {
      console.log(dim("Would import: " + servers.map((s) => s.name).join(", ")));
      return;
    }
    const result = importServers(store, servers, { colorCycle: true });
    store.save();
    ok(`Imported ${result.instancesCreated.length} instance(s), ${result.definitionsCreated.length} new definition(s).`);
    if (result.instancesCreated.length) console.log(dim("  " + result.instancesCreated.join(", ")));
    if (result.skipped.length) console.log(dim("  skipped: " + result.skipped.join(", ")));
  });

program
  .command("export")
  .description("Write a shareable, secrets-free manifest a teammate can sync")
  .option("--out <file>", "output file", "harbor.yaml")
  .option("--profile <id>", "export just this profile and its instances")
  .option("--name <name>", "label the manifest")
  .action(async (opts) => {
    const { exportManifest, writeManifest } = await import("../core/manifest.js");
    const store = ConfigStore.load();
    if (opts.profile && !store.getProfile(opts.profile)) return fail(`No such profile "${opts.profile}".`);
    const manifest = exportManifest(store, { profileId: opts.profile, name: opts.name });
    writeManifest(manifest, opts.out);
    ok(`Wrote ${bold(opts.out)} — ${manifest.definitions.length} defs, ${manifest.instances.length} instances, ${manifest.profiles.length} profiles.`);
    console.log(dim("  Contains references only — no secrets. Safe to commit."));
  });

program
  .command("sync <file>")
  .description("Merge a shared manifest into your library (bring your own credentials)")
  .option("--dry-run", "show what would change without writing")
  .action(async (file, opts) => {
    const { readManifest, syncManifest } = await import("../core/manifest.js");
    const store = ConfigStore.load();
    const manifest = readManifest(file);
    const result = syncManifest(store, manifest, { dryRun: opts.dryRun });
    ok(
      `${opts.dryRun ? "Would add" : "Added"} ${result.instances.length} instance(s), ` +
        `${result.definitions.length} definition(s), ${result.profiles.length} profile(s).`,
    );
    if (result.needsAuth.length) {
      warn("Supply your own credentials:");
      for (const n of result.needsAuth) console.log(dim(`  harbor auth ${n.instance}   (${n.keys.join(", ")})`));
    }
  });

program
  .command("reconcile <path>")
  .description("Route a project through Harbor: import its servers, rewrite .mcp.json, bind a profile")
  .option("--profile <id>", "bind the project to this profile")
  .option("--client <id>", "client the gateway entry targets", "claude-code")
  .option("--no-import", "don't import the project's existing servers first")
  .action(async (p, opts) => {
    const { reconcileProject } = await import("../core/reconcile.js");
    const store = ConfigStore.load();
    if (opts.profile && !store.getProfile(opts.profile)) return fail(`No such profile "${opts.profile}".`);
    const r = reconcileProject(store, p, { profile: opts.profile, client: opts.client, importFirst: opts.import });
    ok(`Reconciled ${dim(r.project)}`);
    if (r.removed.length) console.log(dim(`  routed through Harbor (was: ${r.removed.join(", ")})`));
    if (r.imported.length) console.log(dim(`  imported: ${r.imported.join(", ")}`));
    if (r.boundProfile) console.log(dim(`  bound → ${r.boundProfile}`));
    if (!r.boundProfile) warn(`Bind a profile with: harbor bind ${r.project} <profile>`);
  });

// ---- Setup (client adapters) -------------------------------------------

program
  .command("setup [client]")
  .description("Point a client (or --all) at the Harbor gateway")
  .option("--all", "configure every detected client")
  .option("--command <cmd>", "harbor command path clients should call", "harbor")
  .option("--uninstall", "remove the Harbor entry instead")
  .action((client, opts) => {
    const targets = opts.all
      ? allAdapters().filter((a) => a.detect())
      : client
        ? [getAdapter(client)].filter(Boolean)
        : [];
    if (!targets.length) {
      if (client) return fail(`No such client "${client}".`);
      heading("Clients");
      table(
        allAdapters().map((a) => [
          bold(a.id),
          a.displayName,
          a.detect() ? c("green", "detected") : dim("not found"),
          a.isInstalled() ? c("green", "harbor installed") : "",
        ]),
      );
      console.log(dim("\nRun `harbor setup <client>` or `harbor setup --all`."));
      return;
    }
    for (const a of targets) {
      const changed = opts.uninstall ? a!.uninstall() : a!.install(opts.command);
      if (opts.uninstall) {
        changed ? ok(`Removed Harbor from ${a!.displayName}`) : dim(`${a!.displayName}: nothing to remove`);
      } else {
        changed ? ok(`${a!.displayName} → ${a!.configPath()}`) : console.log(dim(`${a!.displayName}: already configured`));
      }
    }
  });

// ---- Status / log -------------------------------------------------------

program
  .command("status")
  .description("Show the active profile per client and live connections")
  .option("--json", "output JSON")
  .option("--cwd <dir>", "resolve as if in this directory", process.cwd())
  .action(async (opts) => {
    const store = ConfigStore.load();
    const clients = allAdapters();
    const perClient = clients.map((a) => {
      const res = resolveProfile(store, { client: a.id, cwd: opts.cwd });
      return {
        client: a.id,
        installed: a.isInstalled(),
        profile: res.profileId,
        reason: res.reason,
      };
    });
    const live = await fetchDaemonStatus().catch(() => null);
    if (opts.json) return printJson({ perClient, vault: await Vault.backendName(), live });
    heading("Active profile by client");
    table(
      perClient.map((p) => [
        bold(p.client),
        p.installed ? c("green", "●") : dim("○"),
        p.profile ? profileChip(store, p.profile) : dim("(none)"),
        dim(p.reason),
      ]),
      { head: ["client", "setup", "profile", "why"] },
    );
    console.log(dim(`\nvault: ${await Vault.backendName()}   home: ${harborHome()}`));
    if (live?.gateways?.length) {
      heading("Live gateways");
      for (const g of live.gateways) {
        console.log(`  ${bold(g.client ?? "?")} → ${g.profile ?? "(none)"}`);
        for (const i of g.instances ?? []) console.log(`    ${statusDot(i.status)} ${i.label} ${dim(`${i.tools} tools`)}`);
      }
    }
  });

program
  .command("log")
  .description("Show the audit log of tool calls")
  .option("--tail [n]", "show the last N entries", "40")
  .option("--json", "output JSON")
  .option("--instance <id>", "filter by instance")
  .option("--outcome <o>", "filter: ok|error|denied|blocked")
  .action((opts) => {
    const n = parseInt(opts.tail, 10) || 40;
    const entries = AuditLog.read(n, { instance: opts.instance, outcome: opts.outcome });
    if (opts.json) return printJson(entries);
    if (!entries.length) return console.log(dim("No audit entries yet."));
    for (const e of entries) {
      const mark =
        e.outcome === "ok" ? c("green", "✓") : e.outcome === "error" ? c("red", "✗") : c("yellow", "!");
      const t = new Date(e.ts).toLocaleTimeString();
      console.log(
        `${dim(t)} ${mark} ${bold(e.instance)} ${c("cyan", e.tool)} ${dim(e.argsSummary ?? "")}` +
          (e.outcome !== "ok" ? c("yellow", ` [${e.outcome}${e.detail ? ": " + e.detail : ""}]`) : ""),
      );
    }
  });

program
  .command("stats")
  .description("Usage analytics per instance (from the audit log)")
  .option("--json", "output JSON")
  .option("--instance <id>", "limit to one instance")
  .option("--since <duration>", "window, e.g. 24h, 7d, 30m")
  .action(async (opts) => {
    const { computeUsage, parseDuration, formatBytes } = await import("../core/analytics.js");
    let sinceMs: number | undefined;
    if (opts.since) {
      const parsed = parseDuration(opts.since);
      if (parsed == null) return fail(`Bad --since "${opts.since}". Use e.g. 24h, 7d, 30m.`);
      sinceMs = parsed;
    }
    const report = computeUsage({ sinceMs, instance: opts.instance });
    if (opts.json) return printJson(report);
    if (!report.totals.calls) return console.log(dim("No tool calls recorded yet."));

    const errPct = report.totals.calls ? Math.round((report.totals.errors / report.totals.calls) * 100) : 0;
    heading("Usage" + (opts.since ? ` (last ${opts.since})` : ""));
    console.log(
      `  ${report.totals.calls} calls · ${c(errPct ? "yellow" : "green", errPct + "% errors")} · ` +
        `${formatBytes(report.totals.bytes)} · ~${report.totals.estTokens.toLocaleString()} tokens ${dim("(est)")} · ` +
        `${report.totals.instances} instances`,
    );

    heading("By instance");
    table(
      report.instances.map((i) => [
        bold(i.instance),
        String(i.calls),
        i.errors ? c("yellow", String(i.errors)) : dim("0"),
        formatBytes(i.bytes),
        dim("~" + i.estTokens.toLocaleString()),
        i.avgMs != null ? `${i.avgMs}ms` : dim("—"),
        i.lastUsed ? dim(new Date(i.lastUsed).toLocaleString()) : dim("—"),
      ]),
      { head: ["instance", "calls", "errors", "bytes", "~tokens", "avg", "last used"] },
    );

    if (report.topTools.length) {
      heading("Top tools");
      for (const t of report.topTools.slice(0, 8)) {
        console.log(`  ${c("cyan", t.tool)} ${dim("· " + t.instance)} — ${t.calls}`);
      }
    }
  });

program
  .command("vault-info")
  .description("Show which credential backend is in use")
  .action(async () => {
    console.log(`Credential backend: ${bold(await Vault.backendName())}`);
    console.log(dim(`Harbor home: ${harborHome()}`));
  });

// ---- Gateway (the MCP endpoint clients talk to) -------------------------

program
  .command("gateway")
  .description("Run the Harbor MCP gateway over stdio (clients call this)")
  .option("--client <id>", "the client this gateway serves", "unknown")
  .action(async (opts) => {
    // Everything must go to stderr — stdout is the MCP transport.
    const { runGateway } = await import("./gateway-run.js");
    await runGateway(opts.client, process.cwd());
  });

// ---- Daemon (control API + desktop UI) ----------------------------------

program
  .command("daemon")
  .description("Run the Harbor control daemon (HTTP API + UI)")
  .option("--port <port>", "port to listen on")
  .action(async (opts) => {
    const { startDaemon } = await import("../daemon/server.js");
    const store = ConfigStore.load();
    const port = opts.port ? parseInt(opts.port, 10) : store.settings.daemonPort;
    await startDaemon(port);
  });

program
  .command("home")
  .description("Print Harbor's home directory")
  .action(() => console.log(harborHome()));

// ---- helpers ------------------------------------------------------------

function uniqueId(store: ConfigStore, base: string): string {
  let id = sanitizePrefix(base).replace(/_/g, "-");
  let n = 1;
  while (store.getInstance(id)) id = `${sanitizePrefix(base).replace(/_/g, "-")}-${++n}`;
  return id;
}

/** Run a live health check against an instance and print the outcome. */
async function reportHealth(store: ConfigStore, id: string): Promise<void> {
  process.stderr.write(dim("  health-checking…\n"));
  const r = await testInstance(store, id);
  if (r.ok) ok(`health: connected in ${r.durationMs}ms — ${r.tools.length} tools available`);
  else if (r.missingCredentials.length)
    warn(`health: pending credentials (${r.missingCredentials.join(", ")}) — re-check after \`harbor auth ${id}\``);
  else fail(`health: cannot connect — ${r.error}`);
}

function nonSecretCreds(store: ConfigStore, inst: Instance): Record<string, string> {
  const d = store.getDefinition(inst.definition);
  const secretKeys = new Set((d?.credentials ?? []).filter((c) => c.type === "secret").map((c) => c.key));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inst.credentials)) if (!secretKeys.has(k)) out[k] = v;
  return out;
}

function profileChip(store: ConfigStore, profileId: string): string {
  const insts = store.profileInstances(profileId);
  const hasProd = insts.some((i) => i.production);
  return hasProd ? c("red", profileId + " ⚠") : c("green", profileId);
}

async function fetchDaemonStatus(): Promise<any> {
  const { daemonFetch } = await import("../daemon/client.js");
  const res = await daemonFetch("/api/status", { timeoutMs: 400 });
  return res.json();
}

program.parseAsync(process.argv).catch((err) => {
  fail(err?.message ?? String(err));
  process.exit(1);
});
