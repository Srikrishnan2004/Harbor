# ⚓ Harbor

**One place to store, credential, and switch MCP servers across every AI client you use.**

Harbor is a local gateway + desktop app that manages your Model Context Protocol
servers. Define a server once, give it as many credential sets as you need, group
servers into profiles, and apply a profile to any project in Claude Code, Codex,
Gemini CLI, or Antigravity — with a single keystroke and without ever editing a
client config file again.

> The product vision and design rationale live in [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md).
> This README is the guide to the codebase and how to run it.

---

## Why

MCP config today is fragmented: `~/.claude.json`, `.mcp.json` per repo,
`~/.codex/config.toml`, `~/.gemini/settings.json`, each with its own schema. Every
setup assumes one Supabase, one GitHub, one Postgres. Tokens end up in plaintext
JSON. Switching means re-adding servers and restarting clients.

Harbor is a **gateway, not a config editor**. Each client is pointed at Harbor
exactly once; Harbor decides what's behind the door. Switch profiles and the tool
set changes live — no rewriting, no restart.

## What's implemented

Everything in the spec's v0.1–v0.5 roadmap, at least functionally:

| Area | Where |
|---|---|
| MCP gateway (aggregate, namespace, route) | [`engine/src/mcp/gateway.ts`](engine/src/mcp/gateway.ts) |
| Multi-credential **instances** of one definition | [`engine/src/core/types.ts`](engine/src/core/types.ts) |
| **Profiles** + **bindings** (project / client / global) | [`engine/src/core/resolver.ts`](engine/src/core/resolver.ts) |
| Live profile switching (config watch → `tools/list_changed`) | gateway |
| **Credential vault** (OS keychain, encrypted-file fallback) | [`engine/src/core/vault.ts`](engine/src/core/vault.ts) |
| **Namespacing** — always, or only on collision (`alwaysPrefix`) | [`engine/src/core/namespace.ts`](engine/src/core/namespace.ts) |
| Read-only enforcement, confirm-write gates, filesystem scoping | [`engine/src/core/safety.ts`](engine/src/core/safety.ts) |
| Per-instance **tool allow/deny** policy (exact + `*` glob) | [`engine/src/core/safety.ts`](engine/src/core/safety.ts) |
| **Registry** search/install (consumes registry.modelcontextprotocol.io) | [`engine/src/core/registry-client.ts`](engine/src/core/registry-client.ts) |
| Full **audit log** of every upstream call | [`engine/src/core/audit.ts`](engine/src/core/audit.ts) |
| **Usage analytics** — per-instance calls/errors/bytes/latency, top tools | [`engine/src/core/analytics.ts`](engine/src/core/analytics.ts) |
| Client **adapters** (Claude Code, Codex, Gemini CLI, Antigravity) | [`engine/src/adapters/`](engine/src/adapters/) |
| **OAuth** flows for remote servers (PKCE, vault-stored tokens, silent refresh) | [`engine/src/core/oauth.ts`](engine/src/core/oauth.ts) |
| Remote **HTTP/SSE** transports with header + OAuth injection | [`engine/src/mcp/upstream.ts`](engine/src/mcp/upstream.ts) |
| Folder **scanner** + conflict detection + **import** + **reconcile** | [`engine/src/core/reconcile.ts`](engine/src/core/reconcile.ts) |
| **Team manifests** — `harbor export` / `harbor sync` (references only) | [`engine/src/core/manifest.ts`](engine/src/core/manifest.ts) |
| Connection **resiliency** (timeouts, supervised reconnect, drain-on-close) | gateway |
| **Daemon auth** — per-run token, tightened CORS | [`engine/src/daemon/auth.ts`](engine/src/daemon/auth.ts) |
| **CLI** (`harbor …`) | [`engine/src/cli/`](engine/src/cli/) |
| **Control daemon** (HTTP API + approvals) | [`engine/src/daemon/`](engine/src/daemon/) |
| **Desktop UI** (React, served by daemon / wrapped by Tauri) | [`src/`](src/) |

## Architecture at a glance

```
Clients ──MCP(stdio)──► harbor gateway ──► UpstreamConnection(s) ──► real MCP servers
                            │  resolver → namespacer → cred injector → safety → audit
                            └─ heartbeats ─► harbor daemon (HTTP API) ◄── React UI
                                                    │
                                              OS keychain vault
```

- **Engine** ([`engine/`](engine/)) — all logic in TypeScript, run with `tsx`.
- **UI** ([`src/`](src/)) — React + Vite, talks to the daemon over HTTP; also
  wrapped by the Tauri shell in [`src-tauri/`](src-tauri/).

## Install / run

```bash
pnpm install

# Point clients at Harbor (writes a single, surgical entry each)
./bin/harbor setup --all          # or: setup claude-code / codex / gemini-cli / antigravity

# Add instances, credential them, bundle into a profile
./bin/harbor add supabase --id supabase-prod    --label "Supabase (Prod)"    --color red --readonly --production
./bin/harbor add supabase --id supabase-staging --label "Supabase (Staging)" --color yellow
./bin/harbor auth supabase-staging              # stores the secret in the OS keychain
./bin/harbor profile create app-dev
./bin/harbor profile add app-dev supabase-staging
./bin/harbor profile use app-dev                # live in every client immediately

./bin/harbor status                             # active profile per client + live gateways
./bin/harbor log --tail                          # who called what, on which instance
```

Add `./bin/harbor` to your `PATH` (or `pnpm link`) to call it as `harbor`.

### Desktop app / control panel

```bash
pnpm build:ui        # build the React UI into dist/
./bin/harbor daemon  # serves the UI + API on http://127.0.0.1:4747
```

Open <http://127.0.0.1:4747>, or run the native shell with `pnpm tauri dev`
(the Tauri app spawns the daemon for you).

## The CLI

```
harbor search <query>                harbor profile create|add|rm|delete|list|show|use
harbor install <name> [--add]        harbor bind <path> <profile> / bind-client / unbind
harbor list [--test]                 harbor scan <dir> [--report]
harbor add <def> [--allow t] [--deny t]   harbor import <path> | --client <id>
harbor clone <instance> [--id …]     harbor reconcile <path> [--profile p]
harbor auth <instance> [key|--oauth]      harbor stats [--since 7d] [--instance id]
harbor test <instance>               harbor export [--out f] [--profile p]   (team manifest)
harbor rm <instance>                 harbor sync <file> [--dry-run]
harbor def list|add                  harbor setup [client] [--all] [--uninstall]
harbor status / harbor log --tail    harbor gateway --client <id>   (clients launch this)
harbor daemon [--port]               harbor vault-info / harbor home
```

## Develop / test

```bash
pnpm test                 # 72 tests: core, gateway e2e, remote HTTP, OAuth, resiliency, namespacing,
                          #           tool policy, registry, analytics, adapters, scanner, daemon API
pnpm typecheck            # engine + frontend
pnpm dev                  # Vite UI dev server (set VITE_HARBOR_TOKEN from ~/.harbor/daemon.json)
cargo build --manifest-path src-tauri/Cargo.toml   # build the native desktop shell
```

The gateway end-to-end test ([`engine/test/gateway.test.ts`](engine/test/gateway.test.ts))
spins up the real `HarborGateway`, connects an MCP client to it in-memory, and
asserts namespacing, credential injection, read-only filtering, confirm-write
denial, filesystem-scope blocking, and live profile switching against a mock
stdio server.

## Safety model

- **Read-only instances** — the gateway filters out write-capable tools entirely.
- **Confirm-write gates** — flagged writes wait for approval (UI or `HARBOR_AUTO_APPROVE=1`).
- **Color as signal** — red instances render red everywhere; the menu bar goes red when a production profile is live.
- **Keychain only** — Harbor's manifest holds `keychain://` references, never values. Safe to sync or commit.
- **Scoped filesystem servers** — declare a root; the gateway rejects any path outside it.
- **Full audit log** — every upstream call retained in `~/.harbor/audit.log`.

## Where things live

```
engine/src/core/      types, store, vault, resolver, namespace, safety, audit, scanner, importer, health
engine/src/mcp/       upstream connections + the gateway
engine/src/adapters/  one file per client + a JSON base and the Codex TOML adapter
engine/src/cli/       the `harbor` command
engine/src/daemon/    HTTP control API, UI serving, approvals, gateway registry
engine/test/          unit + end-to-end tests (+ mock MCP server fixture)
src/                  React desktop UI
src-tauri/            Tauri shell (spawns the daemon, wraps the UI)
adapters/README.md    how to write a new client adapter
```

Config lives in `~/.harbor/` (override with `HARBOR_HOME`): `harbor.yaml` (the
manifest of references), `audit.log`, and `runtime.json`. Set `HARBOR_VAULT=file`
to force the encrypted-file credential backend instead of the OS keychain.

## License

MIT
