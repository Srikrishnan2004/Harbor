import { z } from "zod";

/**
 * Harbor's data model. Everything a user configures lives here, and the whole
 * thing round-trips to `~/.harbor/harbor.yaml` as a manifest of *references*.
 * Secret values never live in this file — only `keychain://` pointers do.
 */

export const TRANSPORTS = ["stdio", "sse", "http"] as const;
export type Transport = (typeof TRANSPORTS)[number];

export const INSTANCE_COLORS = [
  "gray",
  "blue",
  "green",
  "yellow",
  "orange",
  "red",
  "purple",
  "pink",
  "teal",
] as const;
export type InstanceColor = (typeof INSTANCE_COLORS)[number];

export const CredentialSpec = z.object({
  key: z.string().min(1),
  type: z.enum(["secret", "string"]).default("string"),
  required: z.boolean().default(false),
  description: z.string().optional(),
  /** Where the credential is injected. `env` for stdio, `header` for remote. */
  as: z.enum(["env", "header"]).optional(),
  /** Optional default for non-secret string fields. */
  default: z.string().optional(),
});
export type CredentialSpec = z.infer<typeof CredentialSpec>;

export const ServerDefinition = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  transport: z.enum(TRANSPORTS).default("stdio"),
  // stdio
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  // remote
  url: z.string().optional(),
  // static base env applied to every instance (non-secret)
  env: z.record(z.string(), z.string()).default({}),
  credentials: z.array(CredentialSpec).default([]),
  tags: z.array(z.string()).default([]),
  /** Marks this as a filesystem-style server whose root must be scoped. */
  filesystemRoot: z.boolean().default(false),
  /** Built-in definitions ship with Harbor and can't be deleted, only cloned. */
  builtin: z.boolean().default(false),
});
export type ServerDefinition = z.infer<typeof ServerDefinition>;

export const Instance = z.object({
  id: z.string().min(1),
  definition: z.string().min(1),
  label: z.string().min(1),
  color: z.enum(INSTANCE_COLORS).default("gray"),
  /** Namespace prefix for tools; defaults to a sanitized instance id. */
  prefix: z.string().optional(),
  enabled: z.boolean().default(true),
  /** Gateway filters out write-capable tools entirely. */
  readonly: z.boolean().default(false),
  /** If non-empty, only these tools are exposed (exact name or `*` glob). */
  allowTools: z.array(z.string()).default([]),
  /** These tools are always hidden (exact name or `*` glob). Applied after allow. */
  denyTools: z.array(z.string()).default([]),
  /** Write tools require explicit approval before executing. */
  confirmWrites: z.boolean().default(false),
  /** Flags this instance as touching production data (drives warnings). */
  production: z.boolean().default(false),
  /** How the instance authenticates: static token/header, or an OAuth flow. */
  authMode: z.enum(["token", "oauth"]).default("token"),
  /** For filesystem servers: the single directory the instance may touch. */
  root: z.string().optional(),
  /**
   * Credential values keyed by the definition's credential keys. Secret values
   * are `keychain://...` references; plain strings are stored inline.
   */
  credentials: z.record(z.string(), z.string()).default({}),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type Instance = z.infer<typeof Instance>;

export const Profile = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  instances: z.array(z.string()).default([]),
  warnOnActivate: z.string().optional(),
});
export type Profile = z.infer<typeof Profile>;

export const Binding = z.object({
  scope: z.enum(["project", "client", "global"]),
  /** Project path or client name; omitted for global. */
  match: z.string().optional(),
  profile: z.string().min(1),
});
export type Binding = z.infer<typeof Binding>;

export const Settings = z.object({
  /** Always namespace tools even when there is no collision. */
  alwaysPrefix: z.boolean().default(true),
  /** Port the desktop/control daemon listens on. */
  daemonPort: z.number().int().default(4747),
  /** Default profile applied when nothing else matches. */
  defaultProfile: z.string().optional(),
});
export type Settings = z.infer<typeof Settings>;

export const HarborConfig = z.object({
  version: z.number().int().default(1),
  settings: Settings.prefault({}),
  definitions: z.array(ServerDefinition).default([]),
  instances: z.array(Instance).default([]),
  profiles: z.array(Profile).default([]),
  bindings: z.array(Binding).default([]),
});
export type HarborConfig = z.infer<typeof HarborConfig>;

export function emptyConfig(): HarborConfig {
  return HarborConfig.parse({});
}

/** Sanitize an id into a valid tool-name prefix (`supabase-prod` -> `supabase_prod`). */
export function sanitizePrefix(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

export const KEYCHAIN_SCHEME = "keychain://";

/** Build the canonical keychain reference for an instance credential. */
export function keychainRef(instanceId: string, key: string): string {
  return `${KEYCHAIN_SCHEME}harbor/${instanceId}/${key}`;
}

export function isKeychainRef(value: string): boolean {
  return value.startsWith(KEYCHAIN_SCHEME);
}
