import { ConfigStore } from "../core/store.js";
import { readDaemonInfo } from "./auth.js";

/**
 * Reach a running Harbor daemon from another process (CLI, gateway). Discovers
 * the port and control token from `~/.harbor/daemon.json`, falling back to the
 * configured default port. Returns null if no daemon is reachable.
 */
export function daemonBase(): { url: string; token?: string } {
  const info = readDaemonInfo();
  if (info) return { url: `http://127.0.0.1:${info.port}`, token: info.token };
  const port = ConfigStore.load().settings.daemonPort;
  return { url: `http://127.0.0.1:${port}` };
}

export async function daemonFetch(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { url, token } = daemonBase();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (token) headers["x-harbor-token"] = token;
  const { timeoutMs = 800, ...rest } = init;
  return fetch(url + path, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
}
