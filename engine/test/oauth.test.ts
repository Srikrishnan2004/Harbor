import { describe, it, expect, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { HarborOAuthProvider, hasOAuthTokens } from "../src/core/oauth.js";
import { resolveInjection } from "../src/mcp/upstream.js";
import { Instance, ServerDefinition } from "../src/core/types.js";

beforeEach(() => {
  process.env.HARBOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-oauth-"));
  process.env.HARBOR_VAULT = "file";
});

describe("HarborOAuthProvider", () => {
  it("persists client info, tokens, and PKCE verifier in the vault", async () => {
    const p = new HarborOAuthProvider("remote-1", { redirectUrl: "http://127.0.0.1:9/callback" });

    expect(await p.clientInformation()).toBeUndefined();
    await p.saveClientInformation({ client_id: "abc", redirect_uris: ["http://127.0.0.1:9/callback"] } as any);
    expect((await p.clientInformation())?.client_id).toBe("abc");

    expect(await hasOAuthTokens("remote-1")).toBe(false);
    await p.saveTokens({ access_token: "tok", token_type: "Bearer" } as any);
    expect((await p.tokens())?.access_token).toBe("tok");
    expect(await hasOAuthTokens("remote-1")).toBe(true);

    await p.saveCodeVerifier("verifier-123");
    expect(await p.codeVerifier()).toBe("verifier-123");
  });

  it("exposes fixed client metadata and a stable state", () => {
    const p = new HarborOAuthProvider("x", { redirectUrl: "http://127.0.0.1:9/callback" });
    expect(p.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:9/callback"]);
    expect(p.clientMetadata.grant_types).toContain("refresh_token");
    expect(p.state()).toBe(p.state()); // stable within an instance
  });

  it("refuses to prompt for consent at runtime (no onRedirect)", async () => {
    const p = new HarborOAuthProvider("x", { redirectUrl: "http://127.0.0.1:9/callback" });
    await expect(p.redirectToAuthorization(new URL("https://auth.example.com/authorize"))).rejects.toThrow(
      /consent required/i,
    );
  });

  it("invalidates stored credentials by scope", async () => {
    const p = new HarborOAuthProvider("y", { redirectUrl: "http://127.0.0.1:9/callback" });
    await p.saveTokens({ access_token: "t", token_type: "Bearer" } as any);
    await p.invalidateCredentials("tokens");
    expect(await hasOAuthTokens("y")).toBe(false);
  });
});

describe("credential injection for OAuth instances", () => {
  const def = ServerDefinition.parse({
    id: "remote",
    name: "Remote",
    transport: "http",
    url: "https://api.example.com/mcp",
    credentials: [{ key: "Authorization", type: "secret", required: true, as: "header" }],
  });

  it("does not require a static header credential when authMode is oauth", async () => {
    const oauth = Instance.parse({ id: "r-oauth", definition: "remote", label: "R", authMode: "oauth" });
    const { headers, missing } = await resolveInjection(def, oauth);
    expect(missing).toEqual([]); // OAuth supplies the token, not a static header
    expect(headers.Authorization).toBeUndefined();
  });

  it("still requires the header credential for token-mode instances", async () => {
    const token = Instance.parse({ id: "r-token", definition: "remote", label: "R" });
    const { missing } = await resolveInjection(def, token);
    expect(missing).toEqual(["Authorization"]);
  });
});
