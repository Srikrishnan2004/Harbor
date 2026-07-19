import path from "node:path";
import { ConfigStore } from "./store.js";
import { expandHome, runtimePath } from "./paths.js";
import fs from "node:fs";

export interface ResolveContext {
  /** The client name the gateway was launched for (e.g. "claude-code"). */
  client?: string;
  /** Working directory of the requesting client, if known. */
  cwd?: string;
}

export interface Resolution {
  profileId: string | null;
  /** How the profile was chosen — surfaced in `harbor status`. */
  reason: "override" | "project" | "client" | "global" | "none";
  match?: string;
}

interface RuntimeState {
  override?: string; // explicit profile override set at runtime
}

function readRuntime(): RuntimeState {
  try {
    return JSON.parse(fs.readFileSync(runtimePath(), "utf8"));
  } catch {
    return {};
  }
}

export function setRuntimeOverride(profileId: string | null): void {
  const state = readRuntime();
  if (profileId) state.override = profileId;
  else delete state.override;
  fs.mkdirSync(path.dirname(runtimePath()), { recursive: true });
  fs.writeFileSync(runtimePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

/**
 * Decide which profile is active for a request.
 * Order: explicit override -> per-project binding -> per-client default ->
 * global default -> settings.defaultProfile.
 */
export function resolveProfile(store: ConfigStore, ctx: ResolveContext): Resolution {
  const runtime = readRuntime();
  const envOverride = process.env.HARBOR_PROFILE || runtime.override;
  if (envOverride && store.getProfile(envOverride)) {
    return { profileId: envOverride, reason: "override" };
  }

  // Per-project binding: longest matching path prefix wins.
  if (ctx.cwd) {
    const cwd = path.resolve(ctx.cwd);
    const projectBindings = store.bindings
      .filter((b) => b.scope === "project" && b.match)
      .map((b) => ({ ...b, abs: path.resolve(expandHome(b.match!)) }))
      .filter((b) => cwd === b.abs || cwd.startsWith(b.abs + path.sep))
      .sort((a, b) => b.abs.length - a.abs.length);
    if (projectBindings.length && store.getProfile(projectBindings[0].profile)) {
      return { profileId: projectBindings[0].profile, reason: "project", match: projectBindings[0].abs };
    }
  }

  // Per-client binding.
  if (ctx.client) {
    const clientBinding = store.bindings.find(
      (b) => b.scope === "client" && b.match === ctx.client,
    );
    if (clientBinding && store.getProfile(clientBinding.profile)) {
      return { profileId: clientBinding.profile, reason: "client", match: ctx.client };
    }
  }

  // Global binding.
  const globalBinding = store.bindings.find((b) => b.scope === "global");
  if (globalBinding && store.getProfile(globalBinding.profile)) {
    return { profileId: globalBinding.profile, reason: "global" };
  }

  // Settings default.
  const def = store.settings.defaultProfile;
  if (def && store.getProfile(def)) {
    return { profileId: def, reason: "global" };
  }

  return { profileId: null, reason: "none" };
}
