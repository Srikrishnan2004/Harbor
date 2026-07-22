import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  Anchor,
  ChevronDown,
  KeyRound,
  Package,
  Pencil,
  Plus,
  Search,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  api,
  AuditEntry,
  ClientInfo,
  Config,
  Definition,
  Instance,
  PendingApproval,
  Profile,
  RegistryServer,
  Status,
  UsageReport,
} from "./api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const COLORS = ["gray", "blue", "green", "yellow", "orange", "red", "purple", "pink", "teal"];
type Tab = "library" | "profiles" | "clients" | "projects" | "usage" | "audit";

// Full class strings so Tailwind's compiler keeps them.
const DOT: Record<string, string> = {
  gray: "bg-slate-400",
  blue: "bg-blue-500",
  green: "bg-emerald-500",
  yellow: "bg-yellow-500",
  orange: "bg-orange-500",
  red: "bg-red-500",
  purple: "bg-purple-500",
  pink: "bg-pink-500",
  teal: "bg-teal-500",
};
const ACCENT: Record<string, string> = {
  gray: "border-l-slate-400/70",
  blue: "border-l-blue-500",
  green: "border-l-emerald-500",
  yellow: "border-l-yellow-500",
  orange: "border-l-orange-500",
  red: "border-l-red-500",
  purple: "border-l-purple-500",
  pink: "border-l-pink-500",
  teal: "border-l-teal-500",
};

function Dot({ color, className }: { color: string; className?: string }) {
  return <span className={cn("inline-block size-2.5 rounded-full shrink-0", DOT[color] ?? DOT.gray, className)} />;
}

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [tab, setTab] = useState<Tab>("library");
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ instance?: Instance; definition?: string } | null>(null);
  const [authing, setAuthing] = useState<Instance | null>(null);
  const [showRegistry, setShowRegistry] = useState(false);

  const notify = useCallback((msg: string, err = false) => {
    if (err) toast.error(msg);
    else toast.success(msg);
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
    return activeProfile.instances.map((id) => config.instances.find((i) => i.id === id)).some((i) => i?.production);
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
      <div className="mx-auto max-w-xl p-10">
        <Card className="border-destructive/50 gap-3 p-6">
          <div className="flex items-center gap-2 text-destructive font-semibold">
            <TriangleAlert className="size-5" /> Can't reach the Harbor daemon
          </div>
          <p className="font-mono text-xs text-muted-foreground break-all">{error}</p>
          <p className="text-sm text-muted-foreground">
            Start it with <code className="rounded bg-muted px-1.5 py-0.5">harbor daemon</code> (default port 4747), then reload.
          </p>
          <Button className="w-fit" onClick={refresh}>
            Retry
          </Button>
        </Card>
      </div>
    );
  }
  if (!config) return <div className="p-10 text-muted-foreground">Loading Harbor…</div>;

  const tabs: Tab[] = ["library", "profiles", "clients", "projects", "usage", "audit"];

  return (
    <div className="min-h-screen">
      {/* Top bar */}
      <header
        className={cn(
          "sticky top-0 z-30 border-b bg-background/70 backdrop-blur-xl",
          activeIsProd && "shadow-[inset_0_2px_0_var(--color-destructive)]",
        )}
      >
        <div className="mx-auto flex h-14 max-w-[1200px] items-center gap-3 px-6">
          <Anchor className="size-[18px]" />
          <span className="font-semibold tracking-tight">Harbor</span>
          <span className="select-none text-border">/</span>
          <span className="text-sm text-muted-foreground">MCP gateway</span>
          <div className="flex-1" />
          <Switcher config={config} activeIsProd={activeIsProd} activeProfile={activeProfile} guard={guard} />
        </div>
      </header>

      {/* Tab bar — full-width hairline, white active underline */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="gap-0">
        <div className="sticky top-14 z-20 border-b bg-background/70 backdrop-blur-xl">
          <TabsList className="mx-auto flex h-11 w-full max-w-[1200px] justify-start gap-1 rounded-none bg-transparent p-0 px-6">
            {tabs.map((t) => (
              <TabsTrigger
                key={t}
                value={t}
                className="relative h-11 flex-none rounded-none border-0 border-b-2 border-transparent bg-transparent px-3 text-[13px] capitalize text-muted-foreground data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
              >
                {t}
                {t === "clients" && approvals.length > 0 && (
                  <Badge variant="destructive" className="ml-1.5 h-4 min-w-4 px-1 text-[10px]">
                    {approvals.length}
                  </Badge>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <div className="mx-auto max-w-[1200px] px-6 py-8">
          {approvals.length > 0 && (
            <ApprovalBanner
              approvals={approvals}
              onResolve={(id, ok) => guard(() => api.resolveApproval(id, ok), ok ? "Approved" : "Denied")}
            />
          )}

          <TabsContent value="library">
            <Library
              config={config}
              onAdd={(def) => setEditing({ definition: def })}
              onEdit={(i) => setEditing({ instance: i })}
              onAuth={(i) => setAuthing(i)}
              onDelete={(i) => guard(() => api.deleteInstance(i.id), `Removed ${i.id}`)}
              onTest={(i) => api.test(i.id)}
              onBrowseRegistry={() => setShowRegistry(true)}
            />
          </TabsContent>
          <TabsContent value="profiles">
            <Profiles config={config} status={status} notify={notify} guard={guard} />
          </TabsContent>
          <TabsContent value="clients">
            <Clients guard={guard} notify={notify} status={status} />
          </TabsContent>
          <TabsContent value="projects">
            <Projects guard={guard} notify={notify} config={config} />
          </TabsContent>
          <TabsContent value="usage">
            <Usage config={config} />
          </TabsContent>
          <TabsContent value="audit">
            <Audit />
          </TabsContent>
        </div>
      </Tabs>

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
              try {
                const r = await api.test(saved.id);
                notify(
                  r.ok
                    ? `${saved.id}: healthy · ${r.tools.length} tools`
                    : `${saved.id}: ${r.missingCredentials.length ? "needs credentials" : r.error ?? "unreachable"}`,
                  !r.ok,
                );
              } catch {
                /* best effort */
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
    </div>
  );
}

// ---- Switcher -----------------------------------------------------------

function Switcher({
  config,
  activeProfile,
  activeIsProd,
  guard,
}: {
  config: Config;
  activeProfile: Profile | null;
  activeIsProd: boolean;
  guard: (fn: () => Promise<any>, msg?: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const matches = config.profiles.filter((p) => (p.name + p.id).toLowerCase().includes(q.toLowerCase()));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-2 rounded-full border bg-secondary/60 px-3 py-1.5 text-sm transition-colors hover:bg-secondary cursor-pointer",
            activeIsProd && "border-destructive/60 bg-destructive/15",
          )}
        >
          <Dot color={activeProfile ? profileColor(config, activeProfile) : "gray"} />
          <span className="font-medium">{activeProfile ? activeProfile.name : "No active profile"}</span>
          {activeIsProd && (
            <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">
              PROD
            </Badge>
          )}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <div className="relative mb-1.5">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input autoFocus placeholder="Switch profile…" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 pl-7" />
        </div>
        <div className="max-h-72 overflow-y-auto">
          {matches.map((p) => {
            const on = config.settings.defaultProfile === p.id;
            return (
              <button
                key={p.id}
                onClick={() => {
                  guard(() => api.activate(p.id), `Activated ${p.id}`);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent cursor-pointer",
                  on && "bg-accent",
                )}
              >
                <Dot color={profileColor(config, p)} />
                <span className="flex-1 text-left">{p.name}</span>
                {isProd(config, p) && <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">PROD</Badge>}
              </button>
            );
          })}
          <button
            onClick={() => {
              guard(() => api.activate(null), "Deactivated");
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent cursor-pointer"
          >
            <span className="inline-block size-2.5 rounded-full border" /> Deactivate
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---- shared bits --------------------------------------------------------

function SectionHead({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {sub && <p className="mt-0.5 text-sm text-muted-foreground">{sub}</p>}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">{children}</div>
  );
}

function healthDot(h: "loading" | { ok: boolean; tools: number; error?: string } | undefined) {
  if (h === "loading") return <span className="size-2 animate-pulse rounded-full bg-muted-foreground/50" />;
  if (!h) return <span className="size-2 rounded-full bg-muted-foreground/30" title="untested" />;
  return (
    <span
      className={cn("size-2 rounded-full", h.ok ? "bg-emerald-500" : "bg-red-500")}
      title={h.ok ? `${h.tools} tools` : h.error}
    />
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
      <SectionHead title="Server library" sub="Every instance you've configured. Same definition, different identities, side by side.">
        <Button variant="outline" onClick={onBrowseRegistry}>
          <Package /> Browse registry
        </Button>
        <Select value="" onValueChange={(v) => v && onAdd(v)}>
          <SelectTrigger className="w-[190px]">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Plus className="size-4" /> Add instance…
            </span>
          </SelectTrigger>
          <SelectContent>
            {config.definitions.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SectionHead>

      {config.instances.length === 0 && <Empty>No instances yet. Pick a definition above to add your first one.</Empty>}

      <div className="space-y-6">
        {[...byDef.entries()].map(([defId, insts]) => {
          const def = config.definitions.find((d) => d.id === defId);
          return (
            <div key={defId}>
              <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {def?.name ?? defId} <span className="text-muted-foreground/60">· {insts.length}</span>
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(270px,1fr))] gap-3">
                {insts.map((i) => {
                  const h = health[i.id];
                  return (
                    <Card key={i.id} className={cn("gap-0 border-l-[3px] p-4", ACCENT[i.color] ?? ACCENT.gray)}>
                      <div className="flex items-center gap-2">
                        <Dot color={i.color} />
                        <span className="font-semibold">{i.id}</span>
                        <div className="flex-1" />
                        {healthDot(h)}
                      </div>
                      <div className="mt-0.5 text-[13px] text-muted-foreground">{i.label}</div>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        <Badge variant="secondary" className="font-mono text-[10px] text-muted-foreground">
                          {(i.prefix || i.id.replace(/[^a-z0-9]/gi, "_")) + "__*"}
                        </Badge>
                        {i.readonly && (
                          <Badge variant="outline" className="border-yellow-500/40 text-yellow-500">
                            read-only
                          </Badge>
                        )}
                        {(!!i.allowTools?.length || !!i.denyTools?.length) && (
                          <Badge variant="outline" title={`allow: ${(i.allowTools ?? []).join(", ") || "all"} · deny: ${(i.denyTools ?? []).join(", ") || "none"}`}>
                            tool policy
                          </Badge>
                        )}
                        {i.confirmWrites && <Badge variant="outline">confirm writes</Badge>}
                        {i.production && <Badge variant="destructive">PROD</Badge>}
                        {i.root && (
                          <Badge variant="outline" title={i.root}>
                            scoped
                          </Badge>
                        )}
                      </div>
                      {h && typeof h !== "string" && (
                        <div className="mt-2 text-xs text-muted-foreground">
                          {h.ok ? `✓ ${h.tools} tools` : `✗ ${h.error}`}
                        </div>
                      )}
                      <div className="mt-3 flex gap-1.5">
                        <Button size="sm" variant="outline" onClick={() => test(i)}>
                          Test
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => onAuth(i)}>
                          <KeyRound /> Auth
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => onEdit(i)}>
                          <Pencil /> Edit
                        </Button>
                        <Button size="icon-sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => onDelete(i)}>
                          <Trash2 />
                        </Button>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
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
    const instances = inProfile.has(instId) ? profile.instances.filter((i) => i !== instId) : [...profile.instances, instId];
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
      <SectionHead title="Profiles" sub="Named bundles of instances. Apply one and it's live in every client at once.">
        <Input placeholder="New profile name" value={newName} onChange={(e) => setNewName(e.target.value)} className="w-48" onKeyDown={(e) => e.key === "Enter" && create()} />
        <Button onClick={create}>
          <Plus /> Create
        </Button>
      </SectionHead>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          {config.profiles.length === 0 && <Empty>No profiles yet.</Empty>}
          {config.profiles.map((p) => {
            const active = config.settings.defaultProfile === p.id;
            return (
              <Card
                key={p.id}
                className={cn("flex-row items-center gap-3 p-3 cursor-pointer transition-colors", active ? "border-emerald-500/60" : "hover:border-foreground/20")}
                onClick={() => setSelected(p.id)}
              >
                <Dot color={profileColor(config, p)} />
                <div className="flex-1">
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {p.instances.length} instances {isProd(config, p) && "· PROD"}
                  </div>
                </div>
                {active ? (
                  <Badge variant="outline" className="border-emerald-500/40 text-emerald-500">
                    active
                  </Badge>
                ) : (
                  <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); guard(() => api.activate(p.id), `Activated ${p.id}`); }}>
                    Use
                  </Button>
                )}
                <Button size="icon-sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={(e) => { e.stopPropagation(); guard(() => api.deleteProfile(p.id), `Deleted ${p.id}`); }}>
                  <Trash2 />
                </Button>
              </Card>
            );
          })}
        </div>

        <Card className="gap-3 p-4">
          {!profile ? (
            <div className="text-sm text-muted-foreground">Select a profile to edit its contents.</div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="font-semibold">{profile.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{profile.id}</span>
              </div>
              {profile.warnOnActivate && (
                <div className="flex items-center gap-1.5 text-xs text-yellow-500">
                  <TriangleAlert className="size-3.5" /> {profile.warnOnActivate}
                </div>
              )}
              <Separator />
              <div className="space-y-0.5">
                {config.instances.map((i) => (
                  <label key={i.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-accent">
                    <Checkbox checked={inProfile.has(i.id)} onCheckedChange={() => toggle(i.id)} />
                    <Dot color={i.color} />
                    <span className="text-sm">{i.label}</span>
                    <span className="ml-auto font-mono text-[11px] text-muted-foreground/70">
                      {(i.prefix || i.id.replace(/[^a-z0-9]/gi, "_")) + "__*"}
                    </span>
                  </label>
                ))}
              </div>
              {gwInstances.length > 0 && (
                <div className="text-xs text-muted-foreground">
                  Live: {gwInstances.map((g: any) => `${g.label} (${g.tools} tools)`).join(", ")}
                </div>
              )}
              <Button
                className="mt-1 w-fit"
                onClick={() => {
                  if (isProd(config, profile)) notify("Heads up: this profile touches PRODUCTION", true);
                  guard(() => api.activate(profile.id), `Activated ${profile.id}`);
                }}
              >
                Activate profile
              </Button>
            </>
          )}
        </Card>
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
      <SectionHead title="Clients" sub="Point each client at Harbor once. After that, everything changes here — never in a client config." />
      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead>Config</TableHead>
              <TableHead>Detected</TableHead>
              <TableHead>Harbor</TableHead>
              <TableHead>Active profile</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {clients.map((c) => {
              const per = status?.perClient.find((p) => p.client === c.id);
              return (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.displayName}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{c.configPath}</TableCell>
                  <TableCell>
                    <span className={cn("inline-block size-2 rounded-full", c.detected ? "bg-emerald-500" : "bg-muted-foreground/30")} />
                  </TableCell>
                  <TableCell>
                    {c.installed ? (
                      <Badge variant="outline" className="border-emerald-500/40 text-emerald-500">installed</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {per?.profile ?? <span className="text-muted-foreground">none</span>}{" "}
                    <span className="text-xs text-muted-foreground">({per?.reason})</span>
                  </TableCell>
                  <TableCell>
                    {c.installed ? (
                      <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => guard(() => api.setup(c.id, true), `Removed from ${c.displayName}`)}>
                        Remove
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => guard(() => api.setup(c.id, false), `Configured ${c.displayName}`)}>
                        Set up
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

// ---- Projects -----------------------------------------------------------

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
      <SectionHead title="Projects" sub="Scan a folder tree to see which projects declare which servers — and where they conflict with a binding." />
      <div className="mb-4 flex gap-2">
        <Input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/home/you/code" onKeyDown={(e) => e.key === "Enter" && scan()} />
        <Button onClick={scan} disabled={busy}>
          {busy ? "Scanning…" : "Scan"}
        </Button>
      </div>

      {report && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span>{report.summary.projects} projects</span>
            <span>{report.summary.servers} servers</span>
            <span>{report.summary.usesHarbor} via Harbor</span>
            <span className={report.summary.conflicts ? "text-destructive" : "text-emerald-500"}>{report.summary.conflicts} conflicts</span>
            {report.projects.length > 0 && (
              <Button size="sm" variant="outline" onClick={() => guard(() => api.import({ path: report.root }), "Imported into library")}>
                Import all
              </Button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-muted-foreground">reconcile →</span>
              <Select value={reconcileProfile || "__none"} onValueChange={(v) => setReconcileProfile(v === "__none" ? "" : v)}>
                <SelectTrigger size="sm" className="w-40">
                  <SelectValue placeholder="(no binding)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">(no binding)</SelectItem>
                  {config.profiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Card className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Project</TableHead>
                  <TableHead>Servers</TableHead>
                  <TableHead>Bound profile</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.projects.map((p: any) => (
                  <TableRow key={p.path} className={p.conflict ? "bg-destructive/10" : ""}>
                    <TableCell className="font-mono text-xs">{p.path.replace(report.root, ".")}</TableCell>
                    <TableCell>{p.servers.map((s: any) => s.name).join(", ")}</TableCell>
                    <TableCell>{p.boundProfile ?? <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell>{p.conflict ? <span className="text-destructive">{p.conflict}</span> : <span className="text-muted-foreground">ok</span>}</TableCell>
                    <TableCell>
                      {p.servers.some((s: any) => s.name !== "harbor") && (
                        <Button size="sm" onClick={() => reconcile(p.path)}>Reconcile</Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
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
      <SectionHead title="Usage" sub="Call volume, error rate, and bytes per instance — derived from the audit log.">
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <Button key={w.label} size="sm" variant={since === w.value ? "default" : "outline"} onClick={() => setSince(w.value)}>
              {w.label}
            </Button>
          ))}
        </div>
      </SectionHead>

      {!report || report.totals.calls === 0 ? (
        <Empty>No tool calls recorded {since ? `in the last ${since}` : "yet"}.</Empty>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="calls" value={report.totals.calls.toLocaleString()} />
            <Stat label="errors" value={`${report.totals.errors} (${pct(report.totals.errors, report.totals.calls)}%)`} tone={report.totals.errors ? "warn" : "ok"} />
            <Stat label="data returned" value={fmtBytes(report.totals.bytes)} />
            <Stat label="≈ tokens (est)" value={`~${report.totals.estTokens.toLocaleString()}`} />
            <Stat label="instances" value={String(report.totals.instances)} />
          </div>

          <Card className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Instance</TableHead>
                  <TableHead>Calls</TableHead>
                  <TableHead />
                  <TableHead>Errors</TableHead>
                  <TableHead>Bytes</TableHead>
                  <TableHead>≈ tokens</TableHead>
                  <TableHead>Avg</TableHead>
                  <TableHead>Last used</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.instances.map((i) => (
                  <TableRow key={i.instance}>
                    <TableCell className="font-medium">
                      <span className="flex items-center gap-2">
                        <Dot color={colorFor(i.instance)} /> {i.instance}
                      </span>
                    </TableCell>
                    <TableCell>{i.calls}</TableCell>
                    <TableCell className="w-28">
                      <div className="h-1.5 w-full rounded-full bg-muted">
                        <div className={cn("h-1.5 rounded-full", DOT[colorFor(i.instance)])} style={{ width: `${(i.calls / maxCalls) * 100}%` }} />
                      </div>
                    </TableCell>
                    <TableCell className={i.errors ? "text-yellow-500" : "text-muted-foreground"}>{i.errors}</TableCell>
                    <TableCell>{fmtBytes(i.bytes)}</TableCell>
                    <TableCell className="text-muted-foreground">~{i.estTokens.toLocaleString()}</TableCell>
                    <TableCell className="text-muted-foreground">{i.avgMs != null ? `${i.avgMs}ms` : "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{i.lastUsed ? new Date(i.lastUsed).toLocaleString() : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          {report.topTools.length > 0 && (
            <div className="mt-6">
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Top tools</h3>
              <Card className="gap-0 p-0">
                {report.topTools.map((t, idx) => (
                  <div key={idx} className="flex items-center gap-2 border-b px-4 py-2 text-sm last:border-0">
                    <span className="font-mono text-teal-400">{t.tool}</span>
                    <span className="text-muted-foreground">· {t.instance}</span>
                    <span className="ml-auto tabular-nums">{t.calls}</span>
                  </div>
                ))}
              </Card>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" }) {
  return (
    <Card className="gap-1 p-4">
      <div className={cn("text-2xl font-bold tabular-nums", tone === "warn" ? "text-yellow-500" : tone === "ok" ? "text-emerald-500" : "")}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </Card>
  );
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
      <SectionHead title="Audit" sub="Every upstream tool call, retained locally. This is how you find the 2am prod hit.">
        <Input placeholder="Filter…" className="w-52" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </SectionHead>
      {shown.length === 0 && <Empty>No tool calls recorded yet.</Empty>}
      <Card className="gap-0 p-0 font-mono text-[13px]">
        {shown.map((e, idx) => (
          <div key={idx} className="flex items-baseline gap-3 border-b px-3 py-1.5 last:border-0">
            <span className="text-muted-foreground/70">{new Date(e.ts).toLocaleTimeString()}</span>
            <span className={e.outcome === "ok" ? "text-emerald-500" : e.outcome === "error" ? "text-red-500" : "text-yellow-500"}>
              {e.outcome === "ok" ? "✓" : e.outcome === "error" ? "✗" : "!"}
            </span>
            <span className="text-muted-foreground">{e.client ?? "?"}</span>
            <span className="font-semibold">{e.instance}</span>
            <span className="text-teal-400">{e.tool}</span>
            <span className="flex-1 truncate text-muted-foreground/70">{e.argsSummary}</span>
            {e.outcome !== "ok" && (
              <span className="text-yellow-500">
                [{e.outcome}
                {e.detail ? `: ${e.detail}` : ""}]
              </span>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}

// ---- Approval banner ----------------------------------------------------

function ApprovalBanner({ approvals, onResolve }: { approvals: PendingApproval[]; onResolve: (id: string, ok: boolean) => void }) {
  return (
    <Card className="mb-5 gap-2 border-destructive/50 bg-destructive/10 p-4">
      {approvals.map((a) => (
        <div key={a.id} className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5 text-sm">
              <TriangleAlert className="size-4 text-destructive" />
              <b>Write approval requested</b> — <span className="font-mono">{a.tool}</span> on <b>{a.label}</b>
              {a.client && <span className="text-muted-foreground"> from {a.client}</span>}
            </div>
            <div className="mt-0.5 font-mono text-xs text-muted-foreground">{JSON.stringify(a.args)}</div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => onResolve(a.id, true)}>Approve</Button>
            <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => onResolve(a.id, false)}>Deny</Button>
          </div>
        </div>
      ))}
    </Card>
  );
}

// ---- Instance editor ----------------------------------------------------

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
  const set = <K extends keyof Instance>(k: K, v: Instance[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setCred = (key: string, v: string) => setForm((f) => ({ ...f, credentials: { ...(f.credentials ?? {}), [key]: v } }));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{instance ? "Edit instance" : `New ${def?.name ?? defId} instance`}</DialogTitle>
          <DialogDescription>Configure this identity and its guardrails.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Instance id</Label>
              <Input value={form.id ?? ""} disabled={!!instance} onChange={(e) => set("id", e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Label</Label>
              <Input value={form.label ?? ""} onChange={(e) => set("label", e.target.value)} />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Color</Label>
            <div className="flex flex-wrap gap-2">
              {COLORS.map((col) => (
                <button
                  key={col}
                  onClick={() => set("color", col)}
                  className={cn("size-6 rounded-full ring-offset-2 ring-offset-card cursor-pointer", DOT[col], form.color === col && "ring-2 ring-foreground")}
                />
              ))}
            </div>
          </div>

          {stringCreds.map((cr) => (
            <div key={cr.key} className="grid gap-1.5">
              <Label>
                {cr.key} {cr.required && <span className="text-muted-foreground">(required)</span>}
              </Label>
              <Input value={(form.credentials ?? {})[cr.key] ?? ""} onChange={(e) => setCred(cr.key, e.target.value)} />
            </div>
          ))}

          {def?.filesystemRoot && (
            <div className="grid gap-1.5">
              <Label>Scoped root directory</Label>
              <Input value={form.root ?? ""} onChange={(e) => set("root", e.target.value)} placeholder="/home/you/project" />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">Allow tools (blank = all; * glob)</Label>
              <Input value={(form.allowTools ?? []).join(", ")} onChange={(e) => set("allowTools", splitList(e.target.value))} placeholder="query, list_*" />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">Deny tools (* glob)</Label>
              <Input value={(form.denyTools ?? []).join(", ")} onChange={(e) => set("denyTools", splitList(e.target.value))} placeholder="delete_*" />
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={!!form.readonly} onCheckedChange={(v) => set("readonly", !!v)} /> read-only</label>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={!!form.confirmWrites} onCheckedChange={(v) => set("confirmWrites", !!v)} /> confirm writes</label>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={!!form.production} onCheckedChange={(v) => set("production", !!v)} /> production</label>
          </div>

          {def?.credentials.some((c) => c.type === "secret") && (
            <p className="text-xs text-muted-foreground">
              Secret credentials ({def.credentials.filter((c) => c.type === "secret").map((c) => c.key).join(", ")}) are stored via the vault — use the <b>Auth</b> button after saving.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave(form)}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
      for (const [key, value] of Object.entries(values)) if (value) await api.auth(instance.id, key, value);
      onSaved();
    } catch {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Credentials · {instance.label}</DialogTitle>
          <DialogDescription>Secrets are stored in {config.vault}; the config only holds a reference.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {isRemote && (
            <div>
              <Button disabled={busy} onClick={runOauth}>
                {busy ? "Authorizing…" : instance.authMode === "oauth" ? "Re-authorize with OAuth" : "Authorize with OAuth"}
              </Button>
              {oauthMsg && <span className="ml-3 text-sm text-muted-foreground">{oauthMsg}</span>}
              {secrets.length > 0 && <p className="mt-2 text-xs text-muted-foreground">Or provide a static token below.</p>}
            </div>
          )}
          {secrets.length === 0 && !isRemote && <p className="text-sm text-muted-foreground">This definition declares no secret credentials.</p>}
          {secrets.map((cr) => (
            <div key={cr.key} className="grid gap-1.5">
              <Label>
                {cr.key} {isStored(instance, cr.key) && <span className="text-muted-foreground">(stored — enter to replace)</span>}
              </Label>
              <Input type="password" autoComplete="off" value={values[cr.key] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [cr.key]: e.target.value }))} />
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button disabled={busy || secrets.length === 0} onClick={save}>Store</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Registry modal -----------------------------------------------------

function RegistryModal({ onClose, onInstalled }: { onClose: () => void; onInstalled: (name: string) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<RegistryServer[] | null>(null);
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
      setResults(null);
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
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Package className="size-5" /> MCP registry</DialogTitle>
          <DialogDescription>Search registry.modelcontextprotocol.io and install a server definition into your library.</DialogDescription>
        </DialogHeader>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input autoFocus placeholder="Search servers… (e.g. github, postgres)" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
          <Button type="submit" disabled={busy}>{busy ? "…" : "Search"}</Button>
        </form>

        {err && (
          <div className="flex items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <TriangleAlert className="size-4 shrink-0" />
            <span className="flex-1">{err}</span>
            <Button size="sm" variant="outline" disabled={busy} onClick={search}>
              Retry
            </Button>
          </div>
        )}

        <div className="max-h-[50vh] space-y-2 overflow-y-auto">
          {results?.length === 0 && !err && <p className="text-sm text-muted-foreground">No matches.</p>}
          {results?.map((s) => {
            const kind = s.packages?.[0]?.registryType ?? (s.remotes?.length ? "remote" : "?");
            return (
              <Card key={s.name} className="flex-row items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-medium">
                    {s.title || s.name} <Badge variant="secondary">{kind}</Badge>
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">{s.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{s.description}</div>
                </div>
                <Button size="sm" disabled={installing === s.name} onClick={() => install(s.name)}>
                  {installing === s.name ? "…" : "Install"}
                </Button>
              </Card>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
function pct(n: number, d: number): number {
  return d ? Math.round((n / d) * 100) : 0;
}
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
