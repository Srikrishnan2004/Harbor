import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { Vault } from "./vault.js";

/**
 * OAuth for remote MCP servers. The MCP SDK drives the authorization-code (PKCE)
 * flow; this provider persists everything it produces — dynamic client
 * registration, the code verifier, and the tokens — in Harbor's vault, scoped
 * per instance. Tokens live in the keychain, never in the manifest, and the
 * gateway reuses/refreshes them silently at connection time.
 */

const KEY_CLIENT = "oauth.client";
const KEY_TOKENS = "oauth.tokens";
const KEY_VERIFIER = "oauth.verifier";

export interface HarborProviderOptions {
  redirectUrl: string;
  /** Called with the authorization URL when interactive consent is needed. */
  onRedirect?: (url: URL) => void | Promise<void>;
}

export class HarborOAuthProvider implements OAuthClientProvider {
  private instanceId: string;
  private opts: HarborProviderOptions;
  private _state = crypto.randomBytes(16).toString("hex");

  constructor(instanceId: string, opts: HarborProviderOptions) {
    this.instanceId = instanceId;
    this.opts = opts;
  }

  get redirectUrl(): string {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Harbor",
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this._state;
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const raw = await Vault.get(this.instanceId, KEY_CLIENT);
    return raw ? (JSON.parse(raw) as OAuthClientInformation) : undefined;
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await Vault.set(this.instanceId, KEY_CLIENT, JSON.stringify(info));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const raw = await Vault.get(this.instanceId, KEY_TOKENS);
    return raw ? (JSON.parse(raw) as OAuthTokens) : undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await Vault.set(this.instanceId, KEY_TOKENS, JSON.stringify(tokens));
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await Vault.set(this.instanceId, KEY_VERIFIER, verifier);
  }

  async codeVerifier(): Promise<string> {
    const raw = await Vault.get(this.instanceId, KEY_VERIFIER);
    if (!raw) throw new Error("no PKCE code verifier stored");
    return raw;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.opts.onRedirect) {
      // Runtime (gateway) has no way to prompt — surface as unauthorized so the
      // instance is flagged for re-auth rather than silently opening a browser.
      throw new Error("OAuth consent required — run `harbor auth <instance> --oauth`");
    }
    await this.opts.onRedirect(authorizationUrl);
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): Promise<void> {
    if (scope === "all" || scope === "client") await Vault.remove(this.instanceId, KEY_CLIENT);
    if (scope === "all" || scope === "tokens") await Vault.remove(this.instanceId, KEY_TOKENS);
    if (scope === "all" || scope === "verifier") await Vault.remove(this.instanceId, KEY_VERIFIER);
  }
}

/** True if an instance already has OAuth tokens stored (so the gateway uses them). */
export async function hasOAuthTokens(instanceId: string): Promise<boolean> {
  return (await Vault.get(instanceId, KEY_TOKENS)) != null;
}

/** Best-effort: open a URL in the user's browser. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* headless — the URL is printed by the caller */
  }
}

export interface OAuthRunResult {
  ok: boolean;
  error?: string;
}

/**
 * Run the interactive OAuth flow for a remote instance: stand up a loopback
 * redirect server, drive the SDK's authorization-code exchange, and store the
 * resulting tokens. `log` receives human-facing progress (the CLI sends it to
 * stderr; the caller decides where consent URLs are shown).
 */
export async function runOAuth(
  serverUrl: string,
  instanceId: string,
  transportKind: "http" | "sse",
  log: (msg: string) => void = () => {},
): Promise<OAuthRunResult> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");

  // Loopback server to catch the OAuth redirect.
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const provider = new HarborOAuthProvider(instanceId, {
    redirectUrl: "http://127.0.0.1:0/callback", // real port patched in below
    onRedirect: (url) => {
      log(`Opening browser for consent:\n  ${url.toString()}`);
      openBrowser(url.toString());
    },
  });

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!u.pathname.startsWith("/callback")) {
      res.writeHead(404);
      return res.end();
    }
    const error = u.searchParams.get("error");
    const code = u.searchParams.get("code");
    const state = u.searchParams.get("state");
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<html><body style="font-family:system-ui;background:#0e1116;color:#e6edf3;text-align:center;padding-top:80px"><h2>⚓ Harbor</h2><p>${
        error ? "Authorization failed: " + error : "Authorized. You can close this tab."
      }</p></body></html>`,
    );
    if (error) rejectCode(new Error(error));
    else if (!code) rejectCode(new Error("no authorization code in callback"));
    else if (state && state !== provider.state()) rejectCode(new Error("state mismatch (possible CSRF)"));
    else resolveCode(code);
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as any).port));
  });
  // Patch the real redirect URL now that we know the port.
  (provider as any).opts.redirectUrl = `http://127.0.0.1:${port}/callback`;

  const makeTransport = () =>
    transportKind === "http"
      ? new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider })
      : new SSEClientTransport(new URL(serverUrl), { authProvider: provider });

  const client = new Client({ name: "harbor-auth", version: "0.1.0" });
  try {
    try {
      await client.connect(makeTransport());
      log("Already authorized — tokens are valid.");
      return { ok: true };
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
    }

    // Consent needed: wait for the loopback redirect, then finish the exchange.
    const code = await withTimeout(codePromise, 300_000, "waiting for authorization");
    const authTransport = makeTransport();
    await authTransport.finishAuth(code);
    // Reconnect with valid tokens to confirm.
    await client.connect(makeTransport());
    log("Authorized — tokens stored in the vault.");
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  } finally {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    server.close();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
