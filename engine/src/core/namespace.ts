import { Instance, sanitizePrefix } from "./types.js";

export const SEP = "__";

/** The namespace prefix for an instance (`supabase-prod` -> `supabase_prod`). */
export function instancePrefix(instance: Instance): string {
  return instance.prefix?.trim() || sanitizePrefix(instance.id);
}

/** Produce the namespaced tool name exposed to clients. */
export function namespacedName(instance: Instance, toolName: string): string {
  return `${instancePrefix(instance)}${SEP}${toolName}`;
}

/**
 * Split a namespaced tool name back into (prefix, originalName). Returns null
 * when the name isn't namespaced.
 */
export function splitNamespaced(name: string): { prefix: string; tool: string } | null {
  const idx = name.indexOf(SEP);
  if (idx < 0) return null;
  return { prefix: name.slice(0, idx), tool: name.slice(idx + SEP.length) };
}

/**
 * Given the instances in a profile, decide which tool names collide across
 * instances. Used to surface collisions in the profile editor even when
 * always-prefix is off.
 */
export function collisions(
  toolsByInstance: Map<string, string[]>,
): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  for (const [instanceId, tools] of toolsByInstance) {
    for (const t of tools) {
      const arr = seen.get(t) ?? [];
      arr.push(instanceId);
      seen.set(t, arr);
    }
  }
  const out = new Map<string, string[]>();
  for (const [tool, owners] of seen) {
    if (owners.length > 1) out.set(tool, owners);
  }
  return out;
}
