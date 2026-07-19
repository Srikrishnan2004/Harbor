import path from "node:path";
import { Instance } from "./types.js";

/**
 * MCP tools may carry annotations (`readOnlyHint`, `destructiveHint`). When they
 * do we trust them; when they don't we fall back to a name heuristic. This is
 * how read-only instances filter out write-capable tools and how confirm-gates
 * decide what needs approval.
 */

const WRITE_VERBS = [
  "create",
  "update",
  "delete",
  "remove",
  "write",
  "insert",
  "drop",
  "truncate",
  "execute",
  "exec",
  "run",
  "set",
  "put",
  "patch",
  "post",
  "add",
  "edit",
  "modify",
  "move",
  "rename",
  "upload",
  "push",
  "merge",
  "apply",
  "revoke",
  "grant",
  "send",
  "publish",
  "deploy",
  "restart",
  "kill",
];

export interface ToolLike {
  name: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    [k: string]: unknown;
  };
}

/** Best-effort determination of whether a tool can mutate state. */
export function isWriteTool(tool: ToolLike): boolean {
  const ann = tool.annotations;
  if (ann && typeof ann.readOnlyHint === "boolean") return !ann.readOnlyHint;
  if (ann && typeof ann.destructiveHint === "boolean" && ann.destructiveHint) return true;
  const name = tool.name.toLowerCase();
  return WRITE_VERBS.some(
    (v) => name === v || name.startsWith(v + "_") || name.startsWith(v) || name.includes("_" + v),
  );
}

/** True when a read-only instance should hide this tool entirely. */
export function isFilteredByReadonly(instance: Instance, tool: ToolLike): boolean {
  return instance.readonly && isWriteTool(tool);
}

/** Glob match supporting `*` wildcards; exact match otherwise. */
function globMatch(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (!pattern.includes("*")) return false;
  const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(name);
}

function matchesAny(patterns: string[], name: string): boolean {
  return patterns.some((p) => globMatch(p, name));
}

/**
 * Tool-level allow/deny policy for an instance. A deny always wins; an
 * allowlist (when set) hides everything not listed. Patterns match the
 * original (un-namespaced) tool name and support `*` wildcards.
 */
export function isFilteredByToolPolicy(instance: Instance, toolName: string): boolean {
  if (instance.denyTools.length && matchesAny(instance.denyTools, toolName)) return true;
  if (instance.allowTools.length && !matchesAny(instance.allowTools, toolName)) return true;
  return false;
}

/** True when calling this tool on this instance requires explicit approval. */
export function requiresConfirmation(instance: Instance, tool: ToolLike): boolean {
  return instance.confirmWrites && isWriteTool(tool);
}

/**
 * Enforce filesystem scoping. For an instance with a declared root, any string
 * argument that looks like a path must resolve inside that root. Returns an
 * error message if a violation is found, else null.
 */
export function checkFilesystemScope(
  instance: Instance,
  args: Record<string, unknown> | undefined,
): string | null {
  if (!instance.root || !args) return null;
  const root = path.resolve(instance.root);
  const offending: string[] = [];

  const inspect = (value: unknown) => {
    if (typeof value !== "string") return;
    // Only treat absolute-looking or traversal paths as candidates.
    if (!value.startsWith("/") && !value.startsWith("~") && !value.includes("..")) return;
    const resolved = path.resolve(root, value.replace(/^~\//, ""));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      offending.push(value);
    }
  };

  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
    else inspect(v);
  };
  walk(args);

  if (offending.length) {
    return `filesystem scope violation: ${offending.join(", ")} is outside ${root}`;
  }
  return null;
}
