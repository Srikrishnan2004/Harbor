import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Resolve Harbor's home directory. Overridable with HARBOR_HOME so tests and
 * sandboxed runs never touch a real user's config.
 */
export function harborHome(): string {
  const override = process.env.HARBOR_HOME;
  if (override && override.trim()) return path.resolve(override);
  return path.join(os.homedir(), ".harbor");
}

export function configPath(): string {
  return path.join(harborHome(), "harbor.yaml");
}

export function vaultPath(): string {
  return path.join(harborHome(), "vault.json");
}

export function auditPath(): string {
  return path.join(harborHome(), "audit.log");
}

export function runtimePath(): string {
  // Ephemeral runtime state (active overrides, daemon socket info).
  return path.join(harborHome(), "runtime.json");
}

export function daemonInfoPath(): string {
  // Written by a running daemon: { token, port, pid, startedAt }.
  return path.join(harborHome(), "daemon.json");
}

export function ensureHome(): string {
  const home = harborHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

/** Expand a leading ~ to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}
