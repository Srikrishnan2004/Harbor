import fs from "node:fs";
import YAML from "yaml";
import { z } from "zod";
import { ConfigStore } from "./store.js";
import { Instance, Profile, ServerDefinition, isKeychainRef } from "./types.js";

/**
 * Shareable, secrets-free manifests for teams. A repo can ship a `harbor.yaml`
 * describing the servers, instances, and profiles it needs; a teammate runs
 * `harbor sync harbor.yaml` to get them in their own library and then supplies
 * their own credentials. The manifest is a set of *references* — it never
 * carries a secret value, so it's safe to commit.
 */

export const HarborManifest = z.object({
  harbor: z.literal(1).default(1),
  name: z.string().optional(),
  definitions: z.array(ServerDefinition).default([]),
  instances: z.array(Instance).default([]),
  profiles: z.array(Profile).default([]),
});
export type HarborManifest = z.infer<typeof HarborManifest>;

/** Strip every secret credential value from an instance, keeping non-secrets. */
function stripSecrets(store: ConfigStore, inst: Instance): Instance {
  const def = store.getDefinition(inst.definition);
  const secretKeys = new Set((def?.credentials ?? []).filter((c) => c.type === "secret").map((c) => c.key));
  const credentials: Record<string, string> = {};
  for (const [k, v] of Object.entries(inst.credentials)) {
    // Drop secret values and any lingering keychain refs (they're machine-local).
    if (secretKeys.has(k) || isKeychainRef(v)) continue;
    credentials[k] = v;
  }
  return { ...inst, credentials };
}

/**
 * Build a manifest for the given profiles (or all). Includes only the custom
 * definitions the instances actually use — built-ins exist everywhere.
 */
export function exportManifest(store: ConfigStore, opts: { profileId?: string; name?: string } = {}): HarborManifest {
  const profiles = opts.profileId
    ? store.profiles.filter((p) => p.id === opts.profileId)
    : store.profiles;

  const instanceIds = new Set(profiles.flatMap((p) => p.instances));
  const instances = (instanceIds.size ? store.instances.filter((i) => instanceIds.has(i.id)) : store.instances).map(
    (i) => stripSecrets(store, i),
  );

  const usedDefIds = new Set(instances.map((i) => i.definition));
  const definitions = store.definitions.filter((d) => !d.builtin && usedDefIds.has(d.id));

  return HarborManifest.parse({ harbor: 1, name: opts.name, definitions, instances, profiles });
}

export function writeManifest(manifest: HarborManifest, file: string): void {
  fs.writeFileSync(file, String(new YAML.Document(manifest)));
}

export function readManifest(file: string): HarborManifest {
  return HarborManifest.parse(YAML.parse(fs.readFileSync(file, "utf8")) ?? {});
}

export interface SyncResult {
  definitions: string[];
  instances: string[];
  profiles: string[];
  /** Instances that still need secret credentials supplied via `harbor auth`. */
  needsAuth: Array<{ instance: string; keys: string[] }>;
}

/**
 * Merge a manifest into the local library. Existing instances keep their own
 * credentials (we never clobber a teammate's secrets); new ones are added and
 * flagged for auth. Definitions and profiles are upserted.
 */
export function syncManifest(store: ConfigStore, manifest: HarborManifest, opts: { dryRun?: boolean } = {}): SyncResult {
  const result: SyncResult = { definitions: [], instances: [], profiles: [], needsAuth: [] };

  for (const def of manifest.definitions) {
    if (!store.getDefinition(def.id)) {
      if (!opts.dryRun) store.upsertDefinition({ ...def, builtin: false });
      result.definitions.push(def.id);
    }
  }

  for (const inst of manifest.instances) {
    const existing = store.getInstance(inst.id);
    // Preserve locally-held credentials; the manifest carries none anyway.
    const merged: Instance = existing
      ? { ...inst, credentials: { ...inst.credentials, ...existing.credentials } }
      : inst;
    if (!opts.dryRun) store.upsertInstance(merged);
    if (!existing) result.instances.push(inst.id);

    const def = store.getDefinition(inst.definition);
    const missing = (def?.credentials ?? [])
      .filter((c) => c.type === "secret" && !merged.credentials[c.key])
      .map((c) => c.key);
    if (missing.length) result.needsAuth.push({ instance: inst.id, keys: missing });
  }

  for (const profile of manifest.profiles) {
    if (!opts.dryRun) store.upsertProfile(profile);
    result.profiles.push(profile.id);
  }

  if (!opts.dryRun) store.save();
  return result;
}
