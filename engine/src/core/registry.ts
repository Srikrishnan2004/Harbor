import { ServerDefinition } from "./types.js";

/**
 * A small catalog of common MCP servers shipped with Harbor so the library is
 * never empty. Harbor is *not* a registry — these are convenience templates;
 * discovery tools (Smithery, mcp-get) feed the rest. Each is validated through
 * the schema so defaults (empty args/env/etc.) are filled in.
 */
const RAW: Array<Partial<ServerDefinition> & { id: string; name: string }> = [
  {
    id: "supabase",
    name: "Supabase",
    description: "Query and manage a Supabase project.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@supabase/mcp-server-supabase@latest"],
    tags: ["database", "backend"],
    credentials: [
      { key: "SUPABASE_ACCESS_TOKEN", type: "secret", required: true, as: "env" },
      { key: "SUPABASE_PROJECT_REF", type: "string", required: true, as: "env" },
    ],
  },
  {
    id: "github",
    name: "GitHub",
    description: "Interact with GitHub repos, issues, and pull requests.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    tags: ["vcs", "code"],
    credentials: [
      { key: "GITHUB_PERSONAL_ACCESS_TOKEN", type: "secret", required: true, as: "env" },
    ],
  },
  {
    id: "postgres",
    name: "Postgres",
    description: "Read-only SQL access to a Postgres database.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    tags: ["database"],
    credentials: [
      { key: "DATABASE_URL", type: "secret", required: true, as: "env" },
    ],
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Inspect Sentry issues and events.",
    transport: "http",
    url: "https://mcp.sentry.dev/mcp",
    tags: ["observability"],
    credentials: [
      { key: "Authorization", type: "secret", required: true, as: "header" },
    ],
  },
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Scoped read/write access to a single directory tree.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    tags: ["local"],
    filesystemRoot: true,
    credentials: [],
  },
];

export const BUILTIN_DEFINITIONS: ServerDefinition[] = RAW.map((d) =>
  ServerDefinition.parse({ ...d, builtin: true }),
);

export function getBuiltin(id: string): ServerDefinition | undefined {
  return BUILTIN_DEFINITIONS.find((d) => d.id === id);
}
