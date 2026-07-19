import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HarborGateway, ApprovalFn } from "../mcp/gateway.js";
import { daemonFetch } from "../daemon/client.js";

/**
 * Run the gateway as a stdio MCP server. This is what every client actually
 * launches (`harbor gateway --client X`). stdout is the MCP transport, so all
 * human output goes to stderr.
 */
export async function runGateway(client: string, cwd: string): Promise<void> {
  const approve = buildApprover();
  const gateway = new HarborGateway({
    client,
    cwd,
    approve,
    onActivate: (res, instances) => {
      const prod = instances.filter((i) => i.production);
      process.stderr.write(
        `[harbor] client=${client} profile=${res.profileId ?? "(none)"} (${res.reason}) ` +
          `instances=${instances.length}${prod.length ? ` PROD:${prod.map((i) => i.id).join(",")}` : ""}\n`,
      );
      heartbeat(client, gateway);
    },
  });

  await gateway.start();
  const transport = new StdioServerTransport();
  await gateway.server.connect(transport);

  // Register with the daemon so `harbor status` shows this live gateway.
  heartbeat(client, gateway);
  const beat = setInterval(() => heartbeat(client, gateway), 5000);
  beat.unref?.();

  const shutdown = async () => {
    clearInterval(beat);
    await gateway.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Best-effort registration with a running daemon (ignored if none). */
function heartbeat(client: string, gateway: HarborGateway): void {
  try {
    const snap = gateway.statusSnapshot();
    void daemonFetch("/api/gateways", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client, profile: snap.profile, instances: snap.instances }),
      timeoutMs: 500,
    }).catch(() => {});
  } catch {
    /* no daemon; ignore */
  }
}

/**
 * Approval hook for confirm-write instances. Order of preference:
 *  1. HARBOR_AUTO_APPROVE=1 — approve (useful for trusted automation).
 *  2. A running daemon — ask it (the UI resolves the prompt).
 *  3. Otherwise deny, with an explanatory message from the gateway.
 */
function buildApprover(): ApprovalFn {
  return async (req) => {
    if (process.env.HARBOR_AUTO_APPROVE === "1") return true;
    try {
      const res = await daemonFetch("/api/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instance: req.instance.id,
          label: req.instance.label,
          tool: req.tool,
          args: req.args,
          client: req.client,
        }),
        timeoutMs: 60_000,
      });
      const body = (await res.json()) as { approved?: boolean };
      return !!body.approved;
    } catch {
      return false;
    }
  };
}
