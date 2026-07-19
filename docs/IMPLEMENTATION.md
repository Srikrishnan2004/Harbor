# Harbor

**One place to store, credential, and switch MCP servers across every AI client you use.**

Harbor is a desktop app + local gateway that manages your Model Context Protocol servers. Define a server once, give it as many credential sets as you need, group servers into profiles, and apply a profile to any project in Claude Code, Codex, Gemini CLI, or Antigravity with a single click.

---

## The problem

MCP configuration today is fragmented and manual.

- **Config lives in N places with N schemas.** `~/.claude.json`, `.mcp.json` per repo, `~/.codex/config.toml`, `~/.gemini/settings.json`, and each IDE's own settings file. Adding one server means editing several files by hand.
- **One server, one identity.** Most setups assume a single Supabase, a single GitHub, a single Postgres. If you need prod, staging, and a client's instance, you either juggle env vars or duplicate config blocks with slightly different names and hope you don't point an agent at prod by mistake.
- **Auth is per-client and repeated.** OAuth flows and API tokens get re-done for every tool. Tokens end up in plaintext JSON on disk.
- **No concept of a working set.** There's no way to say "this project needs Supabase-staging + GitHub + Sentry" and have it just be true across every client.
- **Switching is manual.** `/mcp`, `claude mcp add ...`, re-auth, restart the client. Every time.

## What Harbor does

| | |
|---|---|
| **Server library** | Every MCP server you've ever configured, in one catalog with search, tags, and health status. |
| **Multiple instances** | The same server type with different credentials and scopes — `supabase-prod`, `supabase-staging`, `supabase-clientA` — as first-class, visually distinct entries. |
| **Profiles** | Named bundles of instances. Apply a profile to a project or a client in one action. |
| **Gateway** | A single local endpoint each client points at once. Switching profiles takes effect immediately with no config rewriting and no client restart. |
| **Credential vault** | OS keychain–backed storage. Auth once, reuse everywhere. Tokens never sit in a JSON blob. |
| **Cross-client sync** | Claude Code, Codex, Gemini CLI, Antigravity, and any other MCP client, all fed from the same source of truth. |
| **Folder awareness** | Scan a directory tree and see which projects declare which servers, and where the conflicts are. |

---

## Architecture

The core decision: **Harbor is a gateway, not a config-file editor.**

A config-file editor has to know the exact schema of every client, forever, and rewrite files whenever anything changes. Those schemas are moving targets. A gateway inverts the problem — each client is configured exactly once, to talk to Harbor, and Harbor decides what's behind the door.

```
┌──────────────┐  ┌──────────┐  ┌────────────┐  ┌─────────────┐
│ Claude Code  │  │  Codex   │  │ Gemini CLI │  │ Antigravity │
└──────┬───────┘  └────┬─────┘  └─────┬──────┘  └──────┬──────┘
       │               │              │                │
       └───────────────┴──────┬───────┴────────────────┘
                              │  MCP (stdio / SSE / HTTP)
                              ▼
                  ┌───────────────────────┐
                  │    Harbor Gateway     │
                  │  ┌─────────────────┐  │
                  │  │ Active profile  │  │
                  │  │ resolver        │  │
                  │  ├─────────────────┤  │
                  │  │ Namespacer      │  │
                  │  ├─────────────────┤  │
                  │  │ Credential      │  │
                  │  │ injector        │  │
                  │  ├─────────────────┤  │
                  │  │ Audit log       │  │
                  │  └─────────────────┘  │
                  └───────────┬───────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐   ┌──────────────┐   ┌──────────────────┐
│ supabase-prod │   │ github-work  │   │ postgres-staging │
└───────────────┘   └──────────────┘   └──────────────────┘
        ▲                     ▲                     ▲
        └─────────────────────┼─────────────────────┘
                              │
                   ┌──────────┴──────────┐
                   │  OS Keychain vault  │
                   └─────────────────────┘
```

### Components

**Gateway (Rust or Go).** Speaks MCP upstream to clients and downstream to real servers. Presents the union of the active profile's tools, namespaced by instance. Handles process lifecycle for stdio servers and connection pooling for remote ones.

**Resolver.** Decides which profile is active for a given request. Resolution order: explicit override → per-project binding (matched on cwd or repo root) → per-client default → global default.

**Namespacer.** When two instances expose the same tool, Harbor prefixes them (`supabase_prod__query`, `supabase_staging__query`) so the agent can't confuse them. Prefixes are configurable per instance.

**Credential injector.** Secrets are resolved at connection time from the keychain and injected into the upstream process env or auth headers. They are never written to disk in Harbor's own config, and never exposed to the requesting client.

**Desktop UI (Tauri).** The library, profile editor, folder scanner, health dashboard, and audit viewer.

---

## Core concepts

### Server definition
A template. What the server is, how to launch or reach it, what credentials it requires.

```yaml
id: supabase
name: Supabase
transport: stdio
command: npx
args: ["-y", "@supabase/mcp-server-supabase@latest"]
credentials:
  - key: SUPABASE_ACCESS_TOKEN
    type: secret
    required: true
  - key: SUPABASE_PROJECT_REF
    type: string
    required: true
```

### Instance
A definition plus one concrete credential set, a label, and a color. This is the piece that's missing from every existing tool.

```yaml
instances:
  - id: supabase-prod
    definition: supabase
    label: Supabase (Production)
    color: red
    readonly: true          # gateway refuses write tools
    confirm_writes: true    # requires explicit approval
    credentials:
      SUPABASE_ACCESS_TOKEN: keychain://harbor/supabase-prod/token
      SUPABASE_PROJECT_REF: abcdefghijklmnop

  - id: supabase-staging
    definition: supabase
    label: Supabase (Staging)
    color: yellow
    credentials:
      SUPABASE_ACCESS_TOKEN: keychain://harbor/supabase-staging/token
      SUPABASE_PROJECT_REF: qrstuvwxyz123456
```

### Profile
A named set of instances.

```yaml
profiles:
  - id: app-dev
    name: App Development
    instances: [supabase-staging, github-work, sentry, filesystem-scoped]

  - id: app-prod-debug
    name: Production Debugging
    instances: [supabase-prod, sentry, github-work]
    warn_on_activate: "This profile touches PRODUCTION data."
```

### Binding
Ties a profile to a scope.

```yaml
bindings:
  - scope: project
    match: ~/code/my-app
    profile: app-dev
  - scope: client
    match: gemini-cli
    profile: read-only
  - scope: global
    profile: minimal
```

---

## Setup

Each client is configured once, ever.

**Claude Code**
```bash
claude mcp add harbor --scope user -- harbor gateway --client claude-code
```

**Codex** — in `~/.codex/config.toml`:
```toml
[mcp_servers.harbor]
command = "harbor"
args = ["gateway", "--client", "codex"]
```

**Gemini CLI** — in `~/.gemini/settings.json`:
```json
{
  "mcpServers": {
    "harbor": {
      "command": "harbor",
      "args": ["gateway", "--client", "gemini-cli"]
    }
  }
}
```

**Antigravity** — same shape as Gemini CLI, in the IDE's MCP settings.

After that, every change happens in Harbor. No client config is ever touched again.

---

## Usage

```bash
# Library
harbor list                                  # all instances, with health
harbor add supabase --label "Supabase (Prod)" --id supabase-prod
harbor clone supabase-prod --id supabase-clientA   # same definition, new creds
harbor auth supabase-prod                    # OAuth flow or token prompt, stored in keychain
harbor test supabase-prod                    # connect, list tools, report

# Profiles
harbor profile create app-dev
harbor profile add app-dev supabase-staging github-work sentry
harbor profile use app-dev                   # activate globally
harbor bind ~/code/my-app app-dev            # activate for this project

# Folder awareness
harbor scan ~/code                           # find .mcp.json / client configs in a tree
harbor scan ~/code --report                  # counts, duplicates, conflicts, orphaned creds
harbor import ~/code/my-app                  # pull existing config into the library

# Inspection
harbor status                                # active profile per client, live connections
harbor log --tail                            # which agent called which tool on which instance
```

---

## The UI

**Library.** Grid of instances. Color chip, definition icon, label, health dot, last-used. Instances of the same definition group visually so `supabase-prod` and `supabase-staging` sit side by side and are never mistaken for one another.

**Profile editor.** Two panes — library on the left, profile contents on the right. Drag to add. Tool count and any name collisions shown live, with the resulting namespace prefixes.

**Project view.** Scan a folder, get a table of projects × servers. Red cells mark conflicts (a repo's `.mcp.json` disagrees with its Harbor binding). One click to reconcile.

**Switcher.** Global hotkey, fuzzy-search profiles, Enter to activate. Menu bar shows the active profile with its color, so a red bar means production is live.

**Audit.** Timeline of tool calls: timestamp, client, instance, tool, args summary, result size. Filterable. This is how you find out that an agent hit prod at 2am.

---

## Safety

Multi-instance management makes destructive mistakes *easier*, so the guardrails aren't optional.

- **Read-only instances.** The gateway filters out write-capable tools entirely.
- **Confirmation gates.** Flagged instances require an OS-level approval prompt before a write tool executes.
- **Color as a signal.** Red instances render red in the menu bar, in the switcher, and in the audit log.
- **Profile activation warnings.** Any profile containing a production instance warns on activate.
- **Keychain only.** macOS Keychain, Windows Credential Manager, libsecret. Harbor's own config is a manifest of *references*, never values — safe to sync or commit.
- **Scoped filesystem servers.** Filesystem instances declare their root; the gateway enforces it regardless of what the agent asks for.
- **Full audit log.** Every upstream call, retained locally.

---

## Roadmap

**v0.1 — the wedge**
Gateway with profile switching. Multi-instance credentials. Keychain vault. Claude Code + Codex adapters. CLI only.

**v0.2 — the app**
Tauri desktop UI. Library, profile editor, switcher, health checks. Gemini CLI + Antigravity adapters.

**v0.3 — folders**
Directory scanning, conflict detection, import from existing configs, per-project bindings.

**v0.4 — trust**
Audit log viewer, read-only enforcement, confirmation gates, filesystem scoping.

**v0.5 — teams**
Shareable profile manifests (references only, no secrets). A repo can ship `harbor.yaml` and a teammate runs `harbor sync` to get the right servers with their own credentials.

**Later**
Registry integration for one-click install. Per-instance rate limiting and cost tracking. Tool-level allowlists within an instance. Remote gateway for shared dev environments.

---

## What Harbor is not

- **Not a registry.** Smithery, mcp-get, and the official registry solve discovery. Harbor consumes them.
- **Not a hosting platform.** Servers run wherever they already run.
- **Not a config GUI.** That's the commodity version of this idea, and it's already been built several times.

The bet is narrower and sharper: **the same server, with different identities, switchable in one keystroke, across every client, without ever touching a config file again.**

---

## Prior art

| Tool | What it does | What it doesn't |
|---|---|---|
| Docker MCP Toolkit | Catalog + gateway, containerized | No multi-credential instances, no profiles, Docker-bound |
| MCP Manager / MCPHub | GUI list, enable/disable | Config-file rewriting, single identity per server, no gateway |
| Smithery / mcp-get | Discovery and install | Not a runtime layer, no profile or credential management |
| Toolbase / Fleur | Friendly installer UX | Claude Desktop–centric, no cross-client story |
| Claude Code scopes | user / project / local config | Claude-only, manual, no instance concept |

The gap every one of them leaves: **profiles and multi-credential instances at the gateway layer, shared across clients.** That's Harbor.

---

## Contributing

Adapters are the surface most likely to break as clients evolve. If you use an MCP client Harbor doesn't support yet, an adapter is roughly 100 lines — see `adapters/README.md`.

## License

MIT

---

## As built — implementation notes

This document is the product vision. The working implementation follows it
closely, with these concrete choices:

- **Gateway language.** The spec says "Rust or Go." The gateway is implemented in
  **TypeScript** on the official `@modelcontextprotocol/sdk`, run via `tsx`. This
  keeps one language across gateway, CLI, daemon, and UI, and rides the
  best-supported MCP SDK. See [`engine/src/mcp/gateway.ts`](../engine/src/mcp/gateway.ts).
- **Credential vault.** Backed by the OS keychain via `@napi-rs/keyring`
  (macOS Keychain / Windows Credential Manager / libsecret). Where no keychain
  backend exists (headless CI), it falls back to an **AES-256-GCM encrypted file**
  under `~/.harbor`. Either way the manifest only stores `keychain://` references.
  Force the fallback with `HARBOR_VAULT=file`.
- **Live switching.** The gateway watches `~/.harbor/harbor.yaml` and
  `runtime.json`; on change it re-resolves the active profile, reconnects the
  delta, and emits `notifications/tools/list_changed`. No client restart.
- **Confirm-write approvals.** The stdio gateway can't raise an OS dialog itself,
  so it POSTs a pending approval to the control **daemon** and blocks; the desktop
  UI (or `HARBOR_AUTO_APPROVE=1`) resolves it. With no daemon, writes are denied
  with an explanatory message — safe by default.
- **Desktop shell.** The UI is a React app served by the daemon over HTTP and
  wrapped by Tauri; the Tauri shell spawns `harbor daemon` on launch. This makes
  the same UI usable as a plain browser control panel too.

See the repository [`README.md`](../README.md) for the codebase map and commands.