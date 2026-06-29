import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Radar, Zap, Check, Truck, Package, Users, PhoneCall } from "lucide-react";
import { api, Load, Owner } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { inr, phoneShort, ago } from "../lib/format";
import { Button, Chip, Empty, Eyebrow, Panel, Stat } from "../components/ui";
import { CallBoard } from "../components/CallBoard";

function todayPlus(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function PostLoad({ onPosted }: { onPosted: (l: Load) => void }) {
  const [f, setF] = useState({
    fromLocation: "",
    toLocation: "",
    vehicleType: "16ft",
    pickupDate: todayPlus(1),
    fixedPriceInr: 13000,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ready = f.fromLocation.trim() && f.toLocation.trim() && f.fixedPriceInr > 0;

  async function post() {
    setBusy(true);
    setErr(null);
    try {
      const load = await api.createLoad({ ...f, createdBy: "console" });
      onPosted(load);
      setF({ ...f, fromLocation: "", toLocation: "" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not post load");
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "w-full rounded-lg border border-line bg-ink/60 px-3 py-2.5 text-[14px] text-fg placeholder:text-faint focus:border-amber/60 focus:outline-none focus:ring-1 focus:ring-amber/40";

  return (
    <Panel accent="#FFB020" className="p-4">
      <div className="flex items-center gap-2">
        <Zap size={14} className="text-amber" />
        <Eyebrow>Post a load — match drivers and work the line</Eyebrow>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[1fr_auto_1fr_140px_140px_160px] lg:items-end">
        <label>
          <span className="eyebrow mb-1 block">Pickup</span>
          <input className={inputCls} placeholder="Mumbai" value={f.fromLocation} onChange={(e) => setF({ ...f, fromLocation: e.target.value })} />
        </label>
        <div className="hidden pb-2.5 lg:block">
          <ArrowRight size={18} className="text-amber" />
        </div>
        <label>
          <span className="eyebrow mb-1 block">Drop</span>
          <input className={inputCls} placeholder="Pune" value={f.toLocation} onChange={(e) => setF({ ...f, toLocation: e.target.value })} />
        </label>
        <label>
          <span className="eyebrow mb-1 block">Vehicle</span>
          <input className={inputCls} value={f.vehicleType} onChange={(e) => setF({ ...f, vehicleType: e.target.value })} />
        </label>
        <label>
          <span className="eyebrow mb-1 block">Pickup date</span>
          <input type="date" className={`${inputCls} tnum`} value={f.pickupDate} onChange={(e) => setF({ ...f, pickupDate: e.target.value })} />
        </label>
        <label>
          <span className="eyebrow mb-1 block">Fixed price ₹</span>
          <input type="number" className={`${inputCls} font-mono tnum`} value={f.fixedPriceInr || ""} onChange={(e) => setF({ ...f, fixedPriceInr: Number(e.target.value) })} />
        </label>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button variant="amber" onClick={post} disabled={busy || !ready}>
          <Radar size={14} /> {busy ? "Posting…" : "Post load"}
        </Button>
        {err && <span className="font-mono text-[11px] text-rose">{err}</span>}
      </div>
    </Panel>
  );
}

function MatchPanel({
  load,
  owners,
  calledOwnerIds,
  onFired,
}: {
  load: Load;
  owners: Owner[];
  calledOwnerIds: Set<string>;
  onFired: () => void;
}) {
  const { data: suggestions } = usePolling(() => api.suggestedOwners(load.id), 10000, [load.id]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // preselect matches that haven't been called yet
    if (suggestions) {
      setSel(new Set(suggestions.map((s) => s.owner.id).filter((id) => !calledOwnerIds.has(id))));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestions?.length]);

  async function fire() {
    if (sel.size === 0) return;
    setBusy(true);
    try {
      await api.fireCalls(load.id, [...sel]);
      onFired();
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  return (
    <Panel
      title="Matched drivers"
      right={
        <Button variant="amber" onClick={fire} disabled={busy || sel.size === 0} className="!py-1.5 !text-[12px]">
          <PhoneCall size={13} /> {busy ? "Calling…" : `Start calls · ${sel.size}`}
        </Button>
      }
    >
      <div className="max-h-[280px] overflow-y-auto scrollbar-thin">
        {!suggestions || suggestions.length === 0 ? (
          <Empty icon={<Users size={26} />} title="No matching drivers" hint="Add drivers whose lane and vehicle type fit this load — the matcher ranks them here." />
        ) : (
          suggestions.map(({ owner, score }) => {
            const called = calledOwnerIds.has(owner.id);
            const on = sel.has(owner.id);
            return (
              <button
                key={owner.id}
                onClick={() => toggle(owner.id)}
                className="flex w-full items-center gap-3 border-b border-line/70 px-4 py-2.5 text-left transition-colors hover:bg-panel2/40"
              >
                <span className={`grid h-4 w-4 place-items-center rounded border ${on ? "border-amber bg-amber text-ink" : "border-line2"}`}>
                  {on && <Check size={11} strokeWidth={3} />}
                </span>
                <span className="flex-1">
                  <span className="text-[13px] font-600 text-fg">{owner.name}</span>
                  <span className="ml-2 font-mono text-[11px] tnum text-muted">{phoneShort(owner.phone)}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  {owner.vehicleTypes.slice(0, 2).map((v) => <Chip key={v} color="muted">{v}</Chip>)}
                </span>
                {called && <Chip color="amber" dot>called</Chip>}
                <span className="w-10 text-right font-mono text-[11px] tnum text-faint" title="match score">
                  {"★".repeat(Math.min(score, 3))}
                </span>
              </button>
            );
          })
        )}
      </div>
    </Panel>
  );
}

export function DispatchView() {
  const { data: loads, refresh: refreshLoads } = usePolling(() => api.listLoads(), 5000, []);
  const { data: owners } = usePolling(() => api.listOwners(), 8000, []);
  const [selId, setSelId] = useState<string | null>(null);

  // auto-select newest load if none chosen
  useEffect(() => {
    if (!selId && loads && loads.length) setSelId(loads[0].id);
  }, [loads, selId]);

  const selected = loads?.find((l) => l.id === selId) ?? null;

  // live polling for the selected load's calls + quotes
  const { data: calls, refresh: refreshCalls } = usePolling(
    () => (selId ? api.loadCalls(selId) : Promise.resolve([])),
    2500,
    [selId],
    !!selId,
  );
  const { data: quotes } = usePolling(
    () => (selId ? api.loadQuotes(selId) : Promise.resolve([])),
    2500,
    [selId],
    !!selId,
  );

  const calledOwnerIds = useMemo(() => new Set((calls ?? []).map((c) => c.ownerId)), [calls]);

  const kpi = useMemo(() => {
    const all = loads ?? [];
    const q = quotes ?? [];
    return {
      drivers: owners?.length ?? 0,
      loads: all.length,
      calling: all.filter((l) => l.status === "CALLING").length,
      accepted: q.filter((x) => x.available === "YES" && x.acceptsFixed).length,
    };
  }, [loads, owners, quotes]);

  async function followup(ownerId: string) {
    if (!selId) return;
    await api.followup(selId, ownerId);
    refreshCalls();
  }

  return (
    <div className="flex flex-col gap-4">
      {/* KPI strip */}
      <div className="grid grid-cols-2 divide-x divide-line rounded-xl border border-line bg-panel/60 sm:grid-cols-4">
        <Stat label="Drivers" value={kpi.drivers} />
        <Stat label="Loads" value={kpi.loads} />
        <Stat label="On air" value={kpi.calling} tone="amber" />
        <Stat label="Accepted" value={kpi.accepted} tone="go" />
      </div>

      <PostLoad
        onPosted={(l) => {
          setSelId(l.id);
          refreshLoads();
        }}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
        {/* loads list */}
        <Panel title="Loads" className="self-start">
          <div className="max-h-[520px] overflow-y-auto scrollbar-thin">
            {!loads || loads.length === 0 ? (
              <Empty icon={<Package size={26} />} title="No loads yet" hint="Post a load above to start sourcing vehicles." />
            ) : (
              loads.map((l) => {
                const on = l.id === selId;
                return (
                  <button
                    key={l.id}
                    onClick={() => setSelId(l.id)}
                    className={`relative flex w-full flex-col gap-1 border-b border-line/70 px-4 py-3 text-left transition-colors ${on ? "bg-panel2/60" : "hover:bg-panel2/40"}`}
                  >
                    {on && <span className="absolute left-0 top-0 h-full w-[3px] bg-amber" />}
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 font-display text-[14px] font-700 text-fg">
                        {l.fromLocation}
                        <ArrowRight size={13} className="text-amber" />
                        {l.toLocation}
                      </span>
                      <Chip
                        color={l.status === "CALLING" ? "amber" : l.status === "CLOSED" ? "muted" : "cyan"}
                        dot
                        pulse={l.status === "CALLING"}
                      >
                        {l.status}
                      </Chip>
                    </div>
                    <div className="flex items-center gap-2 font-mono text-[11px] tnum text-muted">
                      <span className="flex items-center gap-1"><Truck size={11} className="text-faint" />{l.vehicleType}</span>
                      <span className="text-go">{inr(l.fixedPriceInr)}</span>
                      <span className="text-faint">· {ago(l.createdAt)}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </Panel>

        {/* selected load workspace */}
        <div className="flex min-h-[520px] flex-col gap-4">
          {!selected ? (
            <Panel className="flex-1">
              <Empty icon={<Radar size={28} />} title="Select a load" hint="Pick a load on the left, or post a new one to begin sourcing." />
            </Panel>
          ) : (
            <>
              <MatchPanel load={selected} owners={owners ?? []} calledOwnerIds={calledOwnerIds} onFired={refreshCalls} />
              <div className="min-h-[320px] flex-1">
                <CallBoard load={selected} calls={calls ?? []} quotes={quotes ?? []} owners={owners ?? []} onFollowup={followup} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
