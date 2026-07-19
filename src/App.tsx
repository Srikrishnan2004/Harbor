import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";
import {
  api,
  AuditEntry,
  ClientInfo,
  Config,
  Definition,
  Instance,
  PendingApproval,
  Profile,
  Status,
  UsageReport,
} from "./api";

const COLORS = ["gray", "blue", "green", "yellow", "orange", "red", "purple", "pink", "teal"];
type Tab = "library" | "profiles" | "clients" | "projects" | "usage" | "audit";

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [tab, setTab] = useState<Tab>("library");
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ instance?: Instance; definition?: string } | null>(null);
  const [authing, setAuthing] = useState<Instance | null>(null);
  const [showRegistry, setShowRegistry] = useState(false);

  const notify = useCallback((msg: string, err = false) => {
    setToast({ msg, error: err });
    setTimeout(() => setToast(null), 2600);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([api.config(), api.status()]);
      setConfig(c);
      setStatus(s);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll for pending write-approvals so the UI can act as the OS prompt.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const p = await api.pendingApprovals();
        if (alive) setApprovals(p);
      } catch {
        /* daemon offline */
      }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const activeProfile = config?.profiles.find((p) => p.id === config?.settings.defaultProfile) ?? null;
  const activeIsProd = useMemo(() => {
    if (!config || !activeProfile) return false;
    return activeProfile.instances
      .map((id) => config.instances.find((i) => i.id === id))
      .some((i) => i?.production);
  }, [config, activeProfile]);

  const guard = useCallback(
    async (fn: () => Promise<any>, msg?: string): Promise<void> => {
      try {
        await fn();
        await refresh();
        if (msg) notify(msg);
      } catch (e: any) {
        notify(e.message, true);
      }
    },
    [refresh, notify],
  );

  if (error && !config) {
    return (
      <div className="content">
        <div className="err-banner">
          <b>Can't reach the Harbor daemon.</b>
          <p className="mono">{error}</p>
          <p>
            Start it with <code>harbor daemon</code> (default port 4747), then reload.
          </p>
        </div>
      </div>
    );
  }
  if (!config) return <div className="content muted">Loading Harbor…</div>;

  return (
    <div className="app">
      <div className={"menubar" + (activeIsProd ? " prod" : "")}>
        <div className="brand">
          <span className="anchor">⚓</span> Harbor
        </div>
        <div className="spacer" />
        <div
          className={"active-pill" + (activeIsProd ? " prod" : "")}
          onClick={() => setSwitcherOpen((v) => !v)}
        >
          <span className={"chip c-" + (activeProfile ? profileColor(config, activeProfile) : "gray")} />
          <span>{activeProfile ? activeProfile.name : "No active profile"}</span>
          {activeIsProd && <span className="tag prod">PROD</span>}
          <span className="caret">▾</span>
          {switcherOpen && (
            <Switcher
              config={config}
              onClose={() => setSwitcherOpen(false)}
              onPick={(id) => guard(() => api.activate(id), id ? `Activated ${id}` : "Deactivated").then(() => setSwitcherOpen(false))}
            />
          )}
        </div>
      </div>

      <div className="tabs">
        {(["library", "profiles", "clients", "projects", "usage", "audit"] as Tab[]).map((t) => (
          <div key={t} className={"tab" + (tab === t ? " active" : "")} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
            {t === "clients" && approvals.length > 0 && <span className="badge">{approvals.length}</span>}
          </div>
        ))}
      </div>

      <div className="content">
        {approvals.length > 0 && (
          <ApprovalBanner
            approvals={approvals}
            onResolve={(id, ok) => guard(() => api.resolveApproval(id, ok), ok ? "Approved" : "Denied")}
          />
        )}

        {tab === "library" && (
          <Library
            config={config}
            onAdd={(def) => setEditing({ definition: def })}
            onEdit={(i) => setEditing({ instance: i })}
            onAuth={(i) => setAuthing(i)}
            onDelete={(i) => guard(() => api.deleteInstance(i.id), `Removed ${i.id}`)}
            onTest={(i) => api.test(i.id)}
            onBrowseRegistry={() => setShowRegistry(true)}
          />
        )}
        {tab === "profiles" && <Profiles config={config} status={status} notify={notify} guard={guard} />}
        {tab === "clients" && <Clients guard={guard} notify={notify} status={status} />}
        {tab === "projects" && <Projects guard={guard} notify={notify} config={config} />}
        {tab === "usage" && <Usage config={config} />}
        {tab === "audit" && <Audit />}
      </div>

      {editing && (
        <InstanceEditor
          config={config}
          instance={editing.instance}
          definitionId={editing.definition}
          onClose={() => setEditing(null)}
          onSave={async (inst) => {
            try {
              const saved = await api.saveInstance(inst);
              await refresh();
              setEditing(null);
              // Health check on save — verify the server actually connects.
              try {
                const r = await api.test(saved.id);
                notify(
                  r.ok
                    ? `${saved.id}: healthy · ${r.tools.length} tools`
                    : `${saved.id}: ${r.missingCredentials.length ? "needs credentials" : r.error ?? "unreachable"}`,
                  !r.ok,
                );
              } catch {
                /* health check best-effort */
              }
            } catch (e: any) {
              notify(e.message, true);
            }
          }}
        />
      )}
      {authing && (
        <AuthModal
          config={config}
          instance={authing}
          onClose={() => setAuthing(null)}
          onSaved={() => {
            setAuthing(null);
            refresh();
            notify("Secret stored in vault");
          }}
        />
      )}
      {showRegistry && (
        <RegistryModal
          onClose={() => setShowRegistry(false)}
          onInstalled={(name) => {
            refresh();
            notify(`Installed ${name}`);
          }}
        />
      )}
      {toast && <div className={"toast" + (toast.error ? " error" : "")}>{toast.msg}</div>}
    </div>
  );
}

// ---- Switcher -----------------------------------------------------------

function Switcher({
  config,
  onClose,
  onPick,
}: {
  config: Config;
  onClose: () => void;
  onPick: (id: string | null) => void;
}) {
  const [q, setQ] = useState("");
  const matches = config.profiles.filter((p) => (p.name + p.id).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="switcher" onClick={(e) => e.stopPropagation()}>
      <input autoFocus placeholder="Switch profile…" value={q} onChange={(e) => setQ(e.target.value)} />
      {matches.map((p) => (
        <div
          key={p.id}
          className={"opt" + (config.settings.defaultProfile === p.id ? " on" : "")}
          onClick={() => onPick(p.id)}
        >
          <span className={"chip c-" + profileColor(config, p)} />
          <span>{p.name}</span>
          {isProd(config, p) && <span className="tag prod">PROD</span>}
        </div>
      ))}
      <div className="opt" onClick={() => onPick(null)}>
        <span className="dot" /> <span className="muted">Deactivate</span>
      </div>
      <div style={{ textAlign: "right" }}>
        <button className="ghost small" onClick={onClose}>
          close
        </button>
      </div>
    </div>
  );
}

// ---- Library ------------------------------------------------------------

function Library({
  config,
  onAdd,
  onEdit,
  onAuth,
  onDelete,
  onTest,
  onBrowseRegistry,
}: {
  config: Config;
  onAdd: (def: string) => void;
  onEdit: (i: Instance) => void;
  onAuth: (i: Instance) => void;
  onDelete: (i: Instance) => void;
  onTest: (i: Instance) => Promise<any>;
  onBrowseRegistry: () => void;
}) {
  const [health, setHealth] = useState<Record<string, "loading" | { ok: boolean; tools: number; error?: string }>>({});
  const byDef = groupBy(config.instances, (i) => i.definition);

  async function test(i: Instance) {
    setHealth((h) => ({ ...h, [i.id]: "loading" }));
    try {
      const r = await onTest(i);
      setHealth((h) => ({ ...h, [i.id]: { ok: r.ok, tools: r.tools.length, error: r.error } }));
    } catch (e: any) {
      setHealth((h) => ({ ...h, [i.id]: { ok: false, tools: 0, error: e.message } }));
    }
  }

  return (
    <div>
      <div className="between">
        <div>
          <h2>Server library</h2>
          <p className="sub">Every instance you've configured. Same definition, different identities, side by side.</p>
        </div>
        <div className="row">
          <button onClick={onBrowseRegistry}>Browse registry</button>
          <select
            defaultValue=""
            style={{ width: 190 }}
            onChange={(e) => {
              if (e.target.value) {
                onAdd(e.target.value);
                e.target.value = "";
              }
            }}
          >
            <option value="" disabled>
              + Add instance…
            </option>
            {config.definitions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {config.instances.length === 0 && (
        <div className="empty">No instances yet. Pick a definition above to add your first one.</div>
      )}

      {[...byDef.entries()].map(([defId, insts]) => {
        const def = config.definitions.find((d) => d.id === defId);
        return (
          <div className="group" key={defId}>
            <div className="group-title">
              {def?.name ?? defId} <span className="faint">· {insts.length}</span>
            </div>
            <div className="grid">
              {insts.map((i) => {
                const h = health[i.id];
                return (
                  <div className={"card c-" + i.color} key={i.id}>
                    <div className="card-head">
                      <span className={"chip c-" + i.color} />
                      <span className="id">{i.id}</span>
                      <div className="spacer" />
                      {h === "loading" ? (
                        <span className="dot" />
                      ) : h ? (
                        <span className={"dot " + (h.ok ? "ok" : "error")} title={h.ok ? `${h.tools} tools` : h.error} />
                      ) : (
                        <span className="dot" title="untested" />
                      )}
                    </div>
                    <div className="label">{i.label}</div>
                    <div className="flags">
                      <span className="tag ns">{(i.prefix || i.id.replace(/[^a-z0-9]/gi, "_")) + "__*"}</span>
                      {i.readonly && <span className="tag ro">read-only</span>}
                      {(!!i.allowTools?.length || !!i.denyTools?.length) && (
                        <span className="tag" title={`allow: ${(i.allowTools ?? []).join(", ") || "all"} · deny: ${(i.denyTools ?? []).join(", ") || "none"}`}>
                          tool policy
                        </span>
                      )}
                      {i.confirmWrites && <span className="tag">confirm writes</span>}
                      {i.production && <span className="tag prod">PROD</span>}
                      {i.root && (
                        <span className="tag" title={i.root}>
                          scoped
                        </span>
                      )}
                    </div>
                    {h && typeof h !== "string" && (
                      <div className="faint" style={{ marginTop: 8, fontSize: 12 }}>
                        {h.ok ? `✓ ${h.tools} tools` : `✗ ${h.error}`}
                      </div>
                    )}
                    <div className="actions">
                      <button className="small" onClick={() => test(i)}>
                        Test
                      </button>
                      <button className="small" onClick={() => onAuth(i)}>
                        Auth
                      </button>
                      <button className="small" onClick={() => onEdit(i)}>
                        Edit
                      </button>
                      <button className="small danger" onClick={() => onDelete(i)}>
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---- Profiles -----------------------------------------------------------

function Profiles({
  config,
  status,
  notify,
  guard,
}: {
  config: Config;
  status: Status | null;
  notify: (m: string, e?: boolean) => void;
  guard: (fn: () => Promise<any>, msg?: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string | null>(config.profiles[0]?.id ?? null);
  const [newName, setNewName] = useState("");
  const profile = config.profiles.find((p) => p.id === selected) ?? null;
  const inProfile = new Set(profile?.instances ?? []);
  const gwInstances = status?.gateways.flatMap((g) => g.instances) ?? [];

  async function toggle(instId: string) {
    if (!profile) return;
    const instances = inProfile.has(instId)
      ? profile.instances.filter((i) => i !== instId)
      : [...profile.instances, instId];
    await guard(() => api.saveProfile({ ...profile, instances }));
  }

  async function create() {
    if (!newName.trim()) return;
    const id = newName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    await guard(() => api.saveProfile({ id, name: newName, instances: [] }), `Created ${id}`);
    setSelected(id);
    setNewName("");
  }

  return (
    <div>
      <div className="between">
        <div>
          <h2>Profiles</h2>
          <p className="sub">Named bundles of instances. Apply one and it's live in every client at once.</p>
        </div>
        <div className="row">
          <input placeholder="New profile name" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ width: 180 }} />
          <button className="primary" onClick={create}>
            Create
          </button>
        </div>
      </div>

      <div className="two-pane">
        <div>
          {config.profiles.length === 0 && <div className="empty">No profiles yet.</div>}
          {config.profiles.map((p) => (
            <div key={p.id} className={"profile-row" + (config.settings.defaultProfile === p.id ? " active" : "")}>
              <span className={"chip c-" + profileColor(config, p)} />
              <div style={{ flex: 1, cursor: "pointer" }} onClick={() => setSelected(p.id)}>
                <div style={{ fontWeight: 600 }}>{p.name}</div>
                <div className="faint" style={{ fontSize: 12 }}>
                  {p.instances.length} instances {isProd(config, p) && "· PROD"}
                </div>
              </div>
              {config.settings.defaultProfile === p.id ? (
                <span className="tag" style={{ color: "var(--ok)" }}>
                  active
                </span>
              ) : (
                <button className="small" onClick={() => guard(() => api.activate(p.id), `Activated ${p.id}`)}>
                  Use
                </button>
              )}
              <button className="small danger" onClick={() => guard(() => api.deleteProfile(p.id), `Deleted ${p.id}`)}>
                ✕
              </button>
            </div>
          ))}
        </div>

        <div className="pane">
          {!profile ? (
            <div className="muted">Select a profile to edit its contents.</div>
          ) : (
            <>
              <div className="between">
                <b>{profile.name}</b>
                <span className="faint mono">{profile.id}</span>
              </div>
              {profile.warnOnActivate && <div className="collisions">⚠ {profile.warnOnActivate}</div>}
              <h3>Instances</h3>
              {config.instances.map((i) => (
                <label key={i.id} className="list-item" style={{ cursor: "pointer" }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={inProfile.has(i.id)} onChange={() => toggle(i.id)} />
                  <span className={"chip c-" + i.color} />
                  <span>{i.label}</span>
                  <span className="faint mono" style={{ marginLeft: "auto", fontSize: 11 }}>
                    {(i.prefix || i.id.replace(/[^a-z0-9]/gi, "_")) + "__*"}
                  </span>
                </label>
              ))}
              {gwInstances.length > 0 && (
                <div className="collisions">Live: {gwInstances.map((g: any) => `${g.label} (${g.tools} tools)`).join(", ")}</div>
              )}
              <div className="row" style={{ marginTop: 14 }}>
                <button
                  className="primary"
                  onClick={() => {
                    if (isProd(config, profile)) notify("Heads up: this profile touches PRODUCTION", true);
                    guard(() => api.activate(profile.id), `Activated ${profile.id}`);
                  }}
                >
                  Activate profile
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Clients ------------------------------------------------------------

function Clients({
  guard,
  notify,
  status,
}: {
  guard: (fn: () => Promise<any>, msg?: string) => Promise<void>;
  notify: (m: string, e?: boolean) => void;
  status: Status | null;
}) {
  const [clients, setClients] = useState<ClientInfo[]>([]);
  useEffect(() => {
    api.clients().then(setClients).catch((e) => notify(e.message, true));
  }, [status, notify]);

  return (
    <div>
      <h2>Clients</h2>
      <p className="sub">Point each client at Harbor once. After that, everything changes here — never in a client config.</p>
      <table>
        <thead>
          <tr>
            <th>Client</th>
            <th>Config</th>
            <th>Detected</th>
            <th>Harbor</th>
            <th>Active profile</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => {
            const per = status?.perClient.find((p) => p.client === c.id);
            return (
              <tr key={c.id}>
                <td>
                  <b>{c.displayName}</b>
                </td>
                <td className="mono faint">{c.configPath}</td>
                <td>{c.detected ? <span className="dot ok" /> : <span className="dot" />}</td>
                <td>
                  {c.installed ? (
                    <span className="tag" style={{ color: "var(--ok)" }}>
                      installed
                    </span>
                  ) : (
                    <span className="faint">—</span>
                  )}
                </td>
                <td>
                  {per?.profile ?? <span className="faint">none</span>} <span className="faint">({per?.reason})</span>
                </td>
                <td>
                  {c.installed ? (
                    <button className="small danger" onClick={() => guard(() => api.setup(c.id, true), `Removed from ${c.displayName}`)}>
                      Remove
                    </button>
                  ) : (
                    <button className="small primary" onClick={() => guard(() => api.setup(c.id, false), `Configured ${c.displayName}`)}>
                      Set up
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- Projects (scanner) -------------------------------------------------

function Projects({
  guard,
  notify,
  config,
}: {
  guard: (fn: () => Promise<any>, msg?: string) => Promise<void>;
  notify: (m: string, e?: boolean) => void;
  config: Config;
}) {
  const [dir, setDir] = useState(config.home.replace(/\.harbor$/, "code"));
  const [report, setReport] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [reconcileProfile, setReconcileProfile] = useState(config.settings.defaultProfile ?? "");

  async function scan() {
    setBusy(true);
    try {
      setReport(await api.scan(dir));
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function reconcile(projectPath: string) {
    try {
      const r = await api.reconcile({ path: projectPath, profile: reconcileProfile || undefined });
      notify(`Reconciled — routed through Harbor${r.boundProfile ? `, bound ${r.boundProfile}` : ""}`);
      setReport(await api.scan(dir));
    } catch (e: any) {
      notify(e.message, true);
    }
  }

  return (
    <div>
      <h2>Projects</h2>
      <p className="sub">Scan a folder tree to see which projects declare which servers — and where they conflict with a binding.</p>
      <div className="row">
        <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/home/you/code" />
        <button className="primary" onClick={scan} disabled={busy}>
          {busy ? "Scanning…" : "Scan"}
        </button>
      </div>

      {report && (
        <>
          <div className="row" style={{ margin: "16px 0", gap: 20 }}>
            <span>{report.summary.projects} projects</span>
            <span>{report.summary.servers} servers</span>
            <span>{report.summary.usesHarbor} via Harbor</span>
            <span style={{ color: report.summary.conflicts ? "var(--danger)" : "var(--ok)" }}>{report.summary.conflicts} conflicts</span>
            {report.projects.length > 0 && (
              <button className="small" onClick={() => guard(() => api.import({ path: report.root }), "Imported into library")}>
                Import all into library
              </button>
            )}
            <span className="spacer" />
            <label style={{ margin: 0 }} className="faint">reconcile → </label>
            <select style={{ width: 160 }} value={reconcileProfile} onChange={(e) => setReconcileProfile(e.target.value)}>
              <option value="">(no binding)</option>
              {config.profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Servers</th>
                <th>Bound profile</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {report.projects.map((p: any) => (
                <tr key={p.path} className={p.conflict ? "conflict" : ""}>
                  <td className="mono">{p.path.replace(report.root, ".")}</td>
                  <td>{p.servers.map((s: any) => s.name).join(", ")}</td>
                  <td>{p.boundProfile ?? <span className="faint">—</span>}</td>
                  <td>{p.conflict ? <span style={{ color: "var(--danger)" }}>{p.conflict}</span> : <span className="faint">ok</span>}</td>
                  <td>
                    {p.servers.some((s: any) => s.name !== "harbor") && (
                      <button className="small primary" onClick={() => reconcile(p.path)}>
                        Reconcile
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ---- Usage --------------------------------------------------------------

const WINDOWS: { label: string; value?: string }[] = [
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "All", value: undefined },
];

function Usage({ config }: { config: Config }) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [since, setSince] = useState<string | undefined>("7d");
  useEffect(() => {
    const load = () => api.usage(since).then(setReport).catch(() => {});
    load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [since]);

  const colorFor = (id: string) => config.instances.find((i) => i.id === id)?.color ?? "gray";
  const maxCalls = Math.max(1, ...(report?.instances ?? []).map((i) => i.calls));

  return (
    <div>
      <div className="between">
        <div>
          <h2>Usage</h2>
          <p className="sub">Call volume, error rate, and bytes per instance — derived from the audit log.</p>
        </div>
        <div className="row">
          {WINDOWS.map((w) => (
            <button key={w.label} className={"small" + (since === w.value ? " primary" : "")} onClick={() => setSince(w.value)}>
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {!report || report.totals.calls === 0 ? (
        <div className="empty">No tool calls recorded {since ? `in the last ${since}` : "yet"}.</div>
      ) : (
        <>
          <div className="row" style={{ gap: 24, margin: "8px 0 20px" }}>
            <Stat label="calls" value={report.totals.calls.toLocaleString()} />
            <Stat label="errors" value={`${report.totals.errors} (${pct(report.totals.errors, report.totals.calls)}%)`} tone={report.totals.errors ? "warn" : "ok"} />
            <Stat label="data returned" value={fmtBytes(report.totals.bytes)} />
            <Stat label="instances" value={String(report.totals.instances)} />
          </div>

          <table>
            <thead>
              <tr><th>Instance</th><th>Calls</th><th></th><th>Errors</th><th>Bytes</th><th>Avg</th><th>Last used</th></tr>
            </thead>
            <tbody>
              {report.instances.map((i) => (
                <tr key={i.instance}>
                  <td><span className={"chip c-" + colorFor(i.instance)} /> <b>{i.instance}</b></td>
                  <td>{i.calls}</td>
                  <td style={{ width: 120 }}>
                    <div style={{ height: 6, background: "var(--bg-elev2)", borderRadius: 3 }}>
                      <div style={{ height: 6, borderRadius: 3, width: `${(i.calls / maxCalls) * 100}%`, background: `var(--c-${colorFor(i.instance)})` }} />
                    </div>
                  </td>
                  <td style={{ color: i.errors ? "var(--warn)" : "var(--text-faint)" }}>{i.errors}</td>
                  <td>{fmtBytes(i.bytes)}</td>
                  <td className="faint">{i.avgMs != null ? `${i.avgMs}ms` : "—"}</td>
                  <td className="faint">{i.lastUsed ? new Date(i.lastUsed).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {report.topTools.length > 0 && (
            <>
              <h3>Top tools</h3>
              <div className="log">
                {report.topTools.map((t, idx) => (
                  <div className="line" key={idx}>
                    <span style={{ color: "var(--c-teal)" }}>{t.tool}</span>
                    <span className="faint">· {t.instance}</span>
                    <span style={{ marginLeft: "auto" }}>{t.calls}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" }) {
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 700, color: tone === "warn" ? "var(--warn)" : tone === "ok" ? "var(--ok)" : "var(--text)" }}>{value}</div>
      <div className="faint" style={{ fontSize: 12 }}>{label}</div>
    </div>
  );
}

function pct(n: number, d: number): number {
  return d ? Math.round((n / d) * 100) : 0;
}
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- Audit --------------------------------------------------------------

function Audit() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    const load = () => api.audit(200).then(setEntries).catch(() => {});
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);
  const shown = entries
    .filter((e) => !filter || (e.instance + e.tool + (e.detail ?? "")).toLowerCase().includes(filter.toLowerCase()))
    .slice()
    .reverse();
  return (
    <div>
      <div className="between">
        <div>
          <h2>Audit</h2>
          <p className="sub">Every upstream tool call, retained locally. This is how you find the 2am prod hit.</p>
        </div>
        <input placeholder="Filter…" style={{ width: 200 }} value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {shown.length === 0 && <div className="empty">No tool calls recorded yet.</div>}
      <div className="log">
        {shown.map((e, idx) => (
          <div className="line" key={idx}>
            <span className="ts">{new Date(e.ts).toLocaleTimeString()}</span>
            <span className={e.outcome === "ok" ? "ok" : e.outcome === "error" ? "err" : "warn"}>
              {e.outcome === "ok" ? "✓" : e.outcome === "error" ? "✗" : "!"}
            </span>
            <span style={{ color: "var(--text-dim)" }}>{e.client ?? "?"}</span>
            <b>{e.instance}</b>
            <span style={{ color: "var(--c-teal)" }}>{e.tool}</span>
            <span className="faint" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {e.argsSummary}
            </span>
            {e.outcome !== "ok" && (
              <span className="warn">
                [{e.outcome}
                {e.detail ? `: ${e.detail}` : ""}]
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Approval banner ----------------------------------------------------

function ApprovalBanner({
  approvals,
  onResolve,
}: {
  approvals: PendingApproval[];
  onResolve: (id: string, ok: boolean) => void;
}) {
  return (
    <div className="approval-banner">
      {approvals.map((a) => (
        <div key={a.id} className="between" style={{ marginBottom: 6 }}>
          <div>
            <b>Write approval requested</b> — <span className="mono">{a.tool}</span> on <b>{a.label}</b>
            {a.client && <span className="faint"> from {a.client}</span>}
            <div className="mono faint" style={{ fontSize: 12 }}>
              {JSON.stringify(a.args)}
            </div>
          </div>
          <div className="row">
            <button className="small primary" onClick={() => onResolve(a.id, true)}>
              Approve
            </button>
            <button className="small danger" onClick={() => onResolve(a.id, false)}>
              Deny
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- Instance editor modal ---------------------------------------------

function InstanceEditor({
  config,
  instance,
  definitionId,
  onClose,
  onSave,
}: {
  config: Config;
  instance?: Instance;
  definitionId?: string;
  onClose: () => void;
  onSave: (i: Partial<Instance>) => void;
}) {
  const defId = instance?.definition ?? definitionId!;
  const def = config.definitions.find((d) => d.id === defId) as Definition | undefined;
  const [form, setForm] = useState<Partial<Instance>>(
    instance ?? {
      id: suggestId(config, defId),
      definition: defId,
      label: def?.name ?? defId,
      color: "gray",
      readonly: false,
      confirmWrites: false,
      production: false,
      credentials: {},
    },
  );
  const stringCreds = (def?.credentials ?? []).filter((c) => c.type === "string");

  function set<K extends keyof Instance>(k: K, v: Instance[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }
  function setCred(key: string, v: string) {
    setForm((f) => ({ ...f, credentials: { ...(f.credentials ?? {}), [key]: v } }));
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{instance ? "Edit instance" : `New ${def?.name ?? defId} instance`}</h2>
        <div className="row">
          <div style={{ flex: 1 }}>
            <label>Instance id</label>
            <input value={form.id ?? ""} disabled={!!instance} onChange={(e) => set("id", e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label>Label</label>
            <input value={form.label ?? ""} onChange={(e) => set("label", e.target.value)} />
          </div>
        </div>

        <label>Color</label>
        <div className="row" style={{ flexWrap: "wrap" }}>
          {COLORS.map((col) => (
            <span
              key={col}
              className={"chip c-" + col}
              onClick={() => set("color", col)}
              style={{
                width: 20,
                height: 20,
                cursor: "pointer",
                outline: form.color === col ? "2px solid var(--text)" : "none",
                outlineOffset: 2,
              }}
            />
          ))}
        </div>

        {stringCreds.map((cr) => (
          <div key={cr.key}>
            <label>
              {cr.key} {cr.required && <span className="faint">(required)</span>}
            </label>
            <input value={(form.credentials ?? {})[cr.key] ?? ""} onChange={(e) => setCred(cr.key, e.target.value)} />
          </div>
        ))}

        {def?.filesystemRoot && (
          <div>
            <label>Scoped root directory</label>
            <input value={form.root ?? ""} onChange={(e) => set("root", e.target.value)} placeholder="/home/you/project" />
          </div>
        )}

        <div className="row">
          <div style={{ flex: 1 }}>
            <label>Allow tools <span className="faint">(comma-sep, blank = all; * glob)</span></label>
            <input
              value={(form.allowTools ?? []).join(", ")}
              onChange={(e) => set("allowTools", splitList(e.target.value))}
              placeholder="query, list_*"
            />
          </div>
          <div style={{ flex: 1 }}>
            <label>Deny tools <span className="faint">(comma-sep; * glob)</span></label>
            <input
              value={(form.denyTools ?? []).join(", ")}
              onChange={(e) => set("denyTools", splitList(e.target.value))}
              placeholder="delete_*"
            />
          </div>
        </div>

        <div className="row" style={{ marginTop: 14, gap: 18 }}>
          <label style={{ margin: 0 }} className="row">
            <input type="checkbox" style={{ width: "auto" }} checked={!!form.readonly} onChange={(e) => set("readonly", e.target.checked)} /> read-only
          </label>
          <label style={{ margin: 0 }} className="row">
            <input type="checkbox" style={{ width: "auto" }} checked={!!form.confirmWrites} onChange={(e) => set("confirmWrites", e.target.checked)} /> confirm writes
          </label>
          <label style={{ margin: 0 }} className="row">
            <input type="checkbox" style={{ width: "auto" }} checked={!!form.production} onChange={(e) => set("production", e.target.checked)} /> production
          </label>
        </div>

        {def?.credentials.some((c) => c.type === "secret") && (
          <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
            Secret credentials ({def.credentials.filter((c) => c.type === "secret").map((c) => c.key).join(", ")}) are stored via the vault — use
            the <b>Auth</b> button after saving.
          </p>
        )}

        <div className="footer">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => onSave(form)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Auth modal ---------------------------------------------------------

function AuthModal({
  config,
  instance,
  onClose,
  onSaved,
}: {
  config: Config;
  instance: Instance;
  onClose: () => void;
  onSaved: () => void;
}) {
  const def = config.definitions.find((d) => d.id === instance.definition);
  const secrets = (def?.credentials ?? []).filter((c) => c.type === "secret");
  const isRemote = def && def.transport !== "stdio" && !!def.url;
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [oauthMsg, setOauthMsg] = useState<string | null>(null);

  async function runOauth() {
    setBusy(true);
    setOauthMsg("Opening browser for consent…");
    try {
      const r = await api.oauth(instance.id);
      setOauthMsg(r.ok ? "✓ Authorized — tokens stored in the vault." : `✗ ${r.error}`);
      if (r.ok) setTimeout(onSaved, 900);
    } catch (e: any) {
      setOauthMsg("✗ " + e.message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      for (const [key, value] of Object.entries(values)) {
        if (value) await api.auth(instance.id, key, value);
      }
      onSaved();
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Credentials · {instance.label}</h2>
        {isRemote && (
          <div style={{ marginBottom: 14 }}>
            <button className="primary" disabled={busy} onClick={runOauth}>
              {busy ? "Authorizing…" : instance.authMode === "oauth" ? "Re-authorize with OAuth" : "Authorize with OAuth"}
            </button>
            {oauthMsg && <span className="faint" style={{ marginLeft: 10 }}>{oauthMsg}</span>}
            {secrets.length > 0 && <p className="faint" style={{ fontSize: 12, marginTop: 10 }}>Or provide a static token below.</p>}
          </div>
        )}
        {secrets.length === 0 && !isRemote && <p className="muted">This definition declares no secret credentials.</p>}
        {secrets.map((cr) => (
          <div key={cr.key}>
            <label>
              {cr.key} {isStored(instance, cr.key) && <span className="faint">(stored — enter to replace)</span>}
            </label>
            <input type="password" autoComplete="off" value={values[cr.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [cr.key]: e.target.value }))} />
          </div>
        ))}
        <p className="faint" style={{ fontSize: 12, marginTop: 12 }}>
          Stored in {config.vault}. Harbor's config only ever holds a reference.
        </p>
        <div className="footer">
          <button onClick={onClose}>Close</button>
          <button className="primary" disabled={busy || secrets.length === 0} onClick={save}>
            Store
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Registry browse modal ---------------------------------------------

function RegistryModal({ onClose, onInstalled }: { onClose: () => void; onInstalled: (name: string) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<import("./api").RegistryServer[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function search() {
    if (!q.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      setResults(await api.registrySearch(q, 20));
    } catch (e: any) {
      setErr(e.message);
      setResults([]);
    } finally {
      setBusy(false);
    }
  }

  async function install(name: string) {
    setInstalling(name);
    try {
      await api.registryInstall(name);
      onInstalled(name);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setInstalling(null);
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
        <h2>MCP registry</h2>
        <p className="faint" style={{ fontSize: 12, marginTop: -8, marginBottom: 12 }}>
          Search registry.modelcontextprotocol.io and install a server definition into your library.
        </p>
        <form className="row" onSubmit={(e) => { e.preventDefault(); search(); }}>
          <input autoFocus placeholder="Search servers… (e.g. github, postgres)" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="primary" type="submit" disabled={busy}>{busy ? "…" : "Search"}</button>
        </form>
        {err && <div className="collisions" style={{ color: "var(--danger)" }}>{err}</div>}
        <div style={{ maxHeight: "50vh", overflow: "auto", marginTop: 12 }}>
          {results?.length === 0 && <div className="faint">No matches.</div>}
          {results?.map((s) => {
            const kind = s.packages?.[0]?.registryType ?? (s.remotes?.length ? "remote" : "?");
            return (
              <div key={s.name} className="profile-row" style={{ marginBottom: 6 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{s.title || s.name} <span className="tag">{kind}</span></div>
                  <div className="faint mono" style={{ fontSize: 11 }}>{s.name}</div>
                  <div className="faint" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.description}</div>
                </div>
                <button className="small primary" disabled={installing === s.name} onClick={() => install(s.name)}>
                  {installing === s.name ? "…" : "Install"}
                </button>
              </div>
            );
          })}
        </div>
        <div className="footer">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ---- helpers ------------------------------------------------------------

function groupBy<T>(arr: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const item of arr) {
    const k = key(item);
    const bucket = m.get(k) ?? [];
    bucket.push(item);
    m.set(k, bucket);
  }
  return m;
}
function profileColor(config: Config, p: Profile): string {
  if (isProd(config, p)) return "red";
  const first = p.instances.map((id) => config.instances.find((i) => i.id === id)).find(Boolean);
  return first?.color ?? "gray";
}
function isProd(config: Config, p: Profile): boolean {
  return p.instances.map((id) => config.instances.find((i) => i.id === id)).some((i) => i?.production);
}
function suggestId(config: Config, defId: string): string {
  let id = defId;
  let n = 1;
  while (config.instances.some((i) => i.id === id)) id = `${defId}-${++n}`;
  return id;
}
function isStored(instance: Instance, key: string): boolean {
  return (instance.credentials?.[key] ?? "").startsWith("keychain://");
}
function splitList(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}
