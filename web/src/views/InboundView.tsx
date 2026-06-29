import { useState } from "react";
import { PhoneIncoming, ArrowRight, MapPin, Check, X, Truck } from "lucide-react";
import { api, DemandRequest } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { inr, phoneShort, ago, place } from "../lib/format";
import { Button, Chip, Empty, Eyebrow, Panel } from "../components/ui";

const STATUS_COLOR: Record<string, any> = {
  NEW: "cyan",
  SOURCING: "amber",
  CONFIRMED: "violet",
  APPROVED: "amber",
  REJECTED: "muted",
};

function DemandCard({
  d,
  onChange,
  onSourced,
}: {
  d: DemandRequest;
  onChange: () => void;
  onSourced: () => void;
}) {
  const [price, setPrice] = useState(d.offeredPriceInr ?? 0);
  const [busy, setBusy] = useState<"a" | "r" | null>(null);
  const isNew = d.status === "NEW";

  async function approve() {
    setBusy("a");
    try {
      const r = await api.approveDemand(d.id, { fixedPriceInr: price || undefined });
      onChange();
      if (r.calledOwners > 0) onSourced();
    } finally {
      setBusy(null);
    }
  }
  async function reject() {
    setBusy("r");
    try {
      await api.rejectDemand(d.id);
      onChange();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel accent={isNew ? "#38BDF8" : undefined} className="p-4">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <PhoneIncoming size={14} className="text-cyan" />
          <span className="font-mono text-[12px] tnum text-fg">{phoneShort(d.customerPhone)}</span>
          <span className="font-mono text-[10px] text-faint">· {ago(d.createdAt)} ago</span>
        </div>
        <Chip color={STATUS_COLOR[d.status]} dot pulse={d.status === "SOURCING"}>
          {d.status}
        </Chip>
      </div>

      <div className="mt-3 flex items-center gap-2 font-display text-[17px] font-700 tracking-[0.02em] text-fg">
        <MapPin size={14} className="text-faint" />
        <span>{place(d.fromText, d.fromResolved)}</span>
        <ArrowRight size={15} className="text-amber" />
        <span>{place(d.toText, d.toResolved)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px]">
        {d.vehicleType && (
          <span className="flex items-center gap-1 font-mono text-muted">
            <Truck size={11} className="text-faint" /> {d.vehicleType}
          </span>
        )}
        {d.pickupDate && <span className="font-mono tnum text-muted">{d.pickupDate}</span>}
        {d.note && <span className="text-faint">“{d.note}”</span>}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-line/70 pt-3">
        <div>
          <Eyebrow>Customer offer</Eyebrow>
          <div className="font-mono text-[18px] font-700 tnum text-cyan">{inr(d.offeredPriceInr)}</div>
        </div>

        {isNew ? (
          <div className="flex items-center gap-2">
            <label className="text-right">
              <span className="eyebrow mb-1 block">Source at</span>
              <input
                type="number"
                value={price || ""}
                onChange={(e) => setPrice(Number(e.target.value))}
                className="w-24 rounded-lg border border-line bg-ink/60 px-2.5 py-1.5 text-right font-mono text-[13px] tnum text-fg focus:border-amber/60 focus:outline-none"
              />
            </label>
            <Button variant="danger" onClick={reject} disabled={!!busy} title="Decline this request">
              <X size={13} /> {busy === "r" ? "…" : "Reject"}
            </Button>
            <Button variant="amber" onClick={approve} disabled={!!busy} title="Create the load and call matching drivers">
              <Check size={13} /> {busy === "a" ? "Sourcing…" : "Approve & source"}
            </Button>
          </div>
        ) : (
          <div className="text-right">
            <Eyebrow>{d.status === "CONFIRMED" ? "Confirmed at" : "Sourcing at"}</Eyebrow>
            <div className="font-mono text-[15px] font-700 tnum text-fg">
              {inr(d.offeredPriceInr)}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

export function InboundView({ onSourced }: { onSourced: () => void }) {
  const { data: demand, refresh } = usePolling(() => api.listDemand(), 4000, []);
  const list = demand ?? [];
  const fresh = list.filter((d) => d.status === "NEW");
  const rest = list.filter((d) => d.status !== "NEW");

  return (
    <div className="mx-auto max-w-[1100px]">
      <Eyebrow>
        {fresh.length} new request{fresh.length === 1 ? "" : "s"} waiting · {list.length} total
      </Eyebrow>

      {list.length === 0 ? (
        <Panel className="mt-4">
          <Empty
            icon={<PhoneIncoming size={28} />}
            title="No inbound requests yet"
            hint="When a customer calls in, the agent captures their route and price here — geocoded and ready to source."
          />
        </Panel>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[...fresh, ...rest].map((d) => (
            <DemandCard key={d.id} d={d} onChange={refresh} onSourced={onSourced} />
          ))}
        </div>
      )}
    </div>
  );
}
