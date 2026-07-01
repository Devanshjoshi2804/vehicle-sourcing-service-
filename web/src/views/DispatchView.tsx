import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Radar, FileText, Package, Plus, X } from "lucide-react";
import { api, CallAttempt, Load, Quote } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { inr, ago } from "../lib/format";
import { Button, Empty, Panel } from "../components/ui";
import { LoadDocket, Run } from "../components/LoadDocket";
import { TheLane } from "../components/TheLane";
import { TheLine, resolveOutcome } from "../components/TheLine";
import { RouteLine } from "../components/RouteLine";

function todayPlus(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// "Write a load ticket" — the intake. A dispatcher fills a docket: where, what,
// when, and the freight they'll hold. Posting it starts the sourcing run.
function TicketForm({ onPosted, onCancel }: { onPosted: (l: Load) => void; onCancel: () => void }) {
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
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't post the load. Check the fields and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="relative overflow-hidden rounded-2xl shadow-hero">
      <div className="absolute inset-0 bg-gradient-to-br from-deep via-deep2 to-deep" />
      <div className="relative px-6 py-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText size={14} className="text-amber" />
            <span className="font-mono text-[10px] font-600 uppercase tracking-[0.22em] text-white/55">
              New load ticket
            </span>
          </div>
          <button onClick={onCancel} className="text-white/40 transition hover:text-white/80" aria-label="Cancel">
            <X size={16} />
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 items-end gap-3 lg:grid-cols-[1fr_auto_1fr_120px_150px_150px]">
          <Lbl t="Pickup">
            <input className="input-dark" placeholder="Mumbai" value={f.fromLocation} onChange={(e) => setF({ ...f, fromLocation: e.target.value })} />
          </Lbl>
          <div className="hidden pb-3 lg:block">
            <ArrowRight size={18} className="text-amber" />
          </div>
          <Lbl t="Drop">
            <input className="input-dark" placeholder="Pune" value={f.toLocation} onChange={(e) => setF({ ...f, toLocation: e.target.value })} />
          </Lbl>
          <Lbl t="Vehicle">
            <input className="input-dark" value={f.vehicleType} onChange={(e) => setF({ ...f, vehicleType: e.target.value })} />
          </Lbl>
          <Lbl t="Pickup date">
            <input type="date" className="input-dark tnum" value={f.pickupDate} onChange={(e) => setF({ ...f, pickupDate: e.target.value })} />
          </Lbl>
          <Lbl t="Fixed freight ₹">
            <input type="number" className="input-dark font-mono tnum" value={f.fixedPriceInr || ""} onChange={(e) => setF({ ...f, fixedPriceInr: Number(e.target.value) })} />
          </Lbl>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button variant="amber" onClick={post} disabled={busy || !ready}>
            <Radar size={15} /> {busy ? "Posting…" : "Post load & source trucks"}
          </Button>
          {err && <span className="font-mono text-[11px] text-rose-200">{err}</span>}
        </div>
      </div>
    </section>
  );
}

function Lbl({ t, children }: { t: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[10px] font-600 uppercase tracking-[0.14em] text-white/45">{t}</span>
      {children}
    </label>
  );
}

export function DispatchView() {
  const { data: loads, refresh: refreshLoads } = usePolling(() => api.listLoads(), 5000, []);
  const { data: owners } = usePolling(() => api.listOwners(), 8000, []);
  const [selId, setSelId] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);

  useEffect(() => {
    if (!selId && !writing && loads && loads.length) setSelId(loads[0].id);
  }, [loads, selId, writing]);

  const selected = loads?.find((l) => l.id === selId) ?? null;

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
  // A demand-sourced load carries a customer demand whose stage drives the rest
  // of the domino (approve → confirm → book). null for dispatcher-posted loads.
  const { data: demandList } = usePolling(
    () => (selId ? api.listDemand({ loadId: selId }) : Promise.resolve([])),
    3000,
    [selId],
    !!selId,
  );
  const demand = demandList?.[0] ?? null;

  const calledOwnerIds = useMemo(() => new Set((calls ?? []).map((c) => c.ownerId)), [calls]);
  const ownerById = useMemo(() => new Map((owners ?? []).map((o) => [o.id, o])), [owners]);

  const run: Run = useMemo(() => {
    const cs = calls ?? [];
    const qs = quotes ?? [];
    const quoteFor = (c: CallAttempt) =>
      qs.filter((q) => q.callAttemptId === c.id || (c.elConversationId && q.elConversationId === c.elConversationId)).slice(-1)[0];
    const latest = new Map<string, CallAttempt>();
    for (const c of cs) {
      const p = latest.get(c.ownerId);
      if (!p || new Date(c.createdAt) >= new Date(p.createdAt)) latest.set(c.ownerId, c);
    }
    const r: Run = { called: latest.size, dialing: 0, onCall: 0, holding: 0, accepted: 0, declined: 0 };
    for (const c of latest.values()) {
      const o = resolveOutcome(c, quoteFor(c));
      if (o === "DIALING") r.dialing++;
      else if (o === "ON_CALL") r.onCall++;
      else if (o === "COUNTER") r.holding++;
      else if (o === "DECLINED") r.declined++;
      else if (o === "ACCEPTED") {
        r.accepted++;
        r.winner = r.winner ?? ownerById.get(c.ownerId)?.name;
      }
    }
    return r;
  }, [calls, quotes, ownerById]);

  const locked = run.accepted > 0 || selected?.status === "LOCKED" || selected?.status === "BOOKED";

  async function followup(ownerId: string) {
    if (!selId) return;
    await api.followup(selId, ownerId);
    refreshCalls();
  }
  async function acceptOwner(ownerId: string, priceInr: number) {
    if (!selId) return;
    await api.acceptOwner(selId, ownerId, priceInr);
    refreshCalls();
    refreshLoads();
  }
  async function reoffer(ownerId: string, priceInr: number) {
    if (!selId) return;
    await api.reoffer(selId, ownerId, priceInr);
    refreshCalls();
  }
  async function closeLoad() {
    if (!selId) return;
    await api.closeLoad(selId);
    refreshLoads();
  }

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[256px_1fr]">
      {/* the tray — load tickets waiting and in flight */}
      <div className="flex flex-col gap-3">
        <Button
          variant="primary"
          onClick={() => {
            setWriting(true);
            setSelId(null);
          }}
          className="w-full !py-3"
        >
          <Plus size={15} /> Write a load ticket
        </Button>

        <Panel title="Load tray" className="self-start">
          <div className="max-h-[640px] overflow-y-auto scrollbar-thin">
            {!loads || loads.length === 0 ? (
              <Empty icon={<Package size={20} />} title="Tray is empty" hint="Write your first load ticket to start sourcing trucks." />
            ) : (
              loads.map((l) => {
                const on = l.id === selId;
                const calling = l.status === "CALLING";
                return (
                  <button
                    key={l.id}
                    onClick={() => {
                      setSelId(l.id);
                      setWriting(false);
                    }}
                    className={`relative block w-full border-b border-line px-4 py-3.5 text-left transition-colors last:border-b-0 ${
                      on ? "bg-brandSoft/60" : "hover:bg-panel2"
                    }`}
                  >
                    {on && <span className="absolute left-0 top-0 h-full w-[3px] bg-brand" />}
                    <RouteLine from={l.fromLocation} to={l.toLocation} active={calling} />
                    <div className="mt-2 flex items-center justify-between font-mono text-[11px] tnum">
                      <span className="text-go">{inr(l.fixedPriceInr)}</span>
                      <span
                        className={`flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[9px] font-700 uppercase tracking-[0.1em] ${
                          calling ? "bg-amberSoft text-amber" : l.status === "CLOSED" ? "bg-panel2 text-faint" : "bg-skySoft text-sky"
                        }`}
                      >
                        {calling && <span className="h-1.5 w-1.5 rounded-full bg-amber animate-pulse-dot" />}
                        {l.status}
                      </span>
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-faint">
                      {l.vehicleType} · {ago(l.createdAt)} ago
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </Panel>
      </div>

      {/* the desk */}
      <div className="flex min-w-0 flex-col gap-5">
        {writing ? (
          <TicketForm
            onPosted={(l) => {
              setWriting(false);
              setSelId(l.id);
              refreshLoads();
            }}
            onCancel={() => setWriting(false)}
          />
        ) : !selected ? (
          <Panel className="min-h-[480px]">
            <Empty
              icon={<Radar size={26} />}
              title="No load on the desk"
              hint="Pick a ticket from the tray, or write a new one to start sourcing a truck."
            />
          </Panel>
        ) : (
          <>
            <LoadDocket load={selected} run={run} locked={locked} />
            <div className="grid min-h-[440px] grid-cols-1 gap-5 xl:grid-cols-[minmax(290px,380px)_1fr]">
              <TheLane load={selected} calledOwnerIds={calledOwnerIds} onFired={refreshCalls} />
              <TheLine
                load={selected}
                calls={calls ?? []}
                quotes={quotes ?? []}
                owners={owners ?? []}
                demandStatus={demand?.status ?? null}
                lockedPrice={demand?.lockedPriceInr ?? null}
                onFollowup={followup}
                onAccept={acceptOwner}
                onReoffer={reoffer}
                onClose={closeLoad}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
