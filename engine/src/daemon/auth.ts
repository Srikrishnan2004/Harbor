import fs from "node:fs";
import crypto from "node:crypto";
import { daemonInfoPath, ensureHome } from "../core/paths.js";

/**
 * The control daemon is guarded by a per-run bearer token. It defends against
 * the real local threat: a malicious web page (or another user) driving the
 * localhost API via the browser. The token lives in `~/.harbor/daemon.json`
 * (0600), which the CLI and the served UI read to authenticate; a cross-origin
 * page can't read that file, so it can't forge the header.
 */
export interface DaemonInfo {
  token: string;
  port: number;
  pid: number;
  startedAt: string;
}

export function writeDaemonInfo(port: number): DaemonInfo {
  ensureHome();
  const info: DaemonInfo = {
    token: crypto.randomBytes(24).toString("hex"),
    port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(daemonInfoPath(), JSON.stringify(info, null, 2), { mode: 0o600 });
  return info;
}

export function readDaemonInfo(): DaemonInfo | null {
  try {
    return JSON.parse(fs.readFileSync(daemonInfoPath(), "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}

export function clearDaemonInfo(): void {
  try {
    fs.rmSync(daemonInfoPath());
  } catch {
    /* ignore */
  }
}

/** Constant-time comparison to avoid leaking the token via timing. */
export function tokenMatches(expected: string, provided: string | undefined | null): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const LOCALHOST = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/** Only localhost origins may make cross-origin requests (and still need the token). */
export function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // same-origin / non-browser (no Origin header)
  return LOCALHOST.test(origin);
}
