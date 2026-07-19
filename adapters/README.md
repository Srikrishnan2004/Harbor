# Harbor client adapters

An adapter teaches Harbor about one MCP client: where its config lives, how to
read the servers it declares, and how to install the single Harbor gateway entry
so that client talks to Harbor from then on.

Adapters are the surface most likely to break as clients evolve, so they're kept
small and isolated. A new one is roughly 100 lines.

## The contract

Every adapter implements [`Adapter`](../engine/src/adapters/types.ts):

| Member | Purpose |
|---|---|
| `id` | Stable slug used as the `--client` value and as a binding match (`claude-code`). |
| `displayName` | Human label. |
| `configPath()` | Absolute path to the client's user-level config file. |
| `detect()` | Is this client installed / configured on the machine? |
| `readServers(file?)` | Parse the MCP servers a config declares — used by `scan` and `import`. |
| `isInstalled()` | Is the Harbor gateway entry already present? |
| `install(cmd?)` | Add/update the Harbor entry pointing at `harbor gateway --client <id>`. |
| `uninstall()` | Remove the Harbor entry. |
| `projectConfigNames` | Per-project config filenames, so folder scans can find repo-level servers. |

`install`/`uninstall` must be **surgical** — touch only Harbor's own entry and
leave everything else in the file untouched.

## Two shapes

Most clients store servers as JSON under an `mcpServers` object. Those extend
[`JsonClientAdapter`](../engine/src/adapters/jsonClient.ts) and only specify a
path and, for remote servers, the URL field name:

```ts
new JsonClientAdapter({
  id: "my-client",
  displayName: "My Client",
  configPath: path.join(home, ".myclient", "mcp.json"),
});
```

Codex uses TOML, so [`CodexAdapter`](../engine/src/adapters/codex.ts) implements
the contract directly with a focused `[mcp_servers.*]` reader/writer.

## Registering

Add your adapter to `allAdapters()` in
[`engine/src/adapters/index.ts`](../engine/src/adapters/index.ts). It then
participates automatically in `harbor setup`, `harbor scan`, `harbor import`,
and `harbor status`.

## Supported today

| Client | Default config | Override env | Format |
|---|---|---|---|
| Claude Code | `~/.claude.json` (+ `.mcp.json` per repo) | `HARBOR_CLAUDE_CONFIG` | JSON |
| Codex | `~/.codex/config.toml` | `HARBOR_CODEX_CONFIG` | TOML |
| Gemini CLI | `~/.gemini/settings.json` | `HARBOR_GEMINI_CONFIG` | JSON |
| Antigravity | `~/.antigravity/settings.json` | `HARBOR_ANTIGRAVITY_CONFIG` | JSON |

Each config path defaults to the client's conventional location and can be
pointed elsewhere with the matching env var — handy where a client's real path
differs by platform or install.
