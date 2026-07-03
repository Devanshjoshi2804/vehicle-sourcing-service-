import { useState } from "react";
import { PhoneIncoming, ArrowRight, MapPin, Check, X, Truck, RotateCw, PhoneCall, Lock } from "lucide-react";
import { api, DemandRequest, DemandStatus } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { inr, phoneShort, ago, place } from "../lib/format";
import { Button, Chip, Empty, Eyebrow, Panel } from "../components/ui";

// The domino, as four nodes the demand walks through. The card lights nodes up to
// where it is and points at the one action the dispatcher owns next.
const STEPS = ["Call drivers", "Driver locked", "Company approved", "Customer booked"];
const STEP_OF: Record<DemandStatus, number> = {
  NEW: 0,
  SOURCING: 0,
  DRIVER_LOCKED: 1,
  CUSTOMER_PENDING: 2,
  BOOKED: 3,
  DECLINED: -1,
  CANCELLED: -1,
  REJECTED: -1,
};

const STATUS_CHIP: Record<DemandStatus, { color: any; label: string; pulse?: boolean }> = {
  NEW: { color: "sky", label: "New" },
  SOURCING: { color: "amber", label: "Calling drivers", pulse: true },
  DRIVER_LOCKED: { color: "amber", label: "Needs approval", pulse: true },
  CUSTOMER_PENDING: { color: "violet", label: "Confirming customer", pulse: true },
  BOOKED: { color: "go", label: "Booked" },
  DECLINED: { color: "rose", label: "Customer declined" },
  CANCELLED: { color: "muted", label: "Cancelled" },
  REJECTED: { color: "muted", label: "Rejected" },
};

function Domino({ status }: { status: DemandStatus }) {
  const at = STEP_OF[status] ?? -1;
  const dead = at === -1;
  const booked = status === "BOOKED";
  return (
    <div className="flex items-center gap-0">
      {STEPS.map((label, i) => {
        const filled = booked || (!dead && i < at);
        const active = !booked && !dead && i === at;
        return (
          <div key={label} className="flex items-center">
            <div className="flex flex-col items-center gap-1" style={{ width: 78 }}>
              <span
                className={`grid h-5 w-5 place-items-center rounded-full text-[10px] ${
                  filled
                    ? "bg-go text-white"
                    : active
                      ? "bg-amber text-white animate-pulse-dot"
                      : "bg-panel2 text-faint ring-1 ring-line2"
                }`}
              >
                {filled ? <Check size={11} strokeWidth={3} /> : i + 1}
              </span>
              <span
                className={`text-center font-mono text-[8.5px] font-600 uppercase leading-tight tracking-[0.06em] ${
                  filled ? "text-go" : active ? "text-amber" : "text-faint"
                }`}
              >
                {label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <span className={`mb-4 h-px w-3 ${i < at && !dead ? "bg-go" : "bg-line2"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function DemandCard({ d, refresh }: { d: DemandRequest; refresh: () => void }) {
  const [price, setPrice] = useState(d.offeredPriceInr ?? 0);
  const [busy, setBusy] = useState<string | null>(null);
  const chip = STATUS_CHIP[d.status] ?? { color: "muted" as const, label: d.status };

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    try {
      await fn();
      refresh();
    } finally {
      setBusy(null);
    }
  }

  const lockedPrice = d.lockedPriceInr ?? d.offeredPriceInr;

  return (
    <Panel className="p-5 transition-shadow hover:shadow-cardhover">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <PhoneIncoming size={14} className="text-sky" />
          <span className="font-mono text-[12px] tnum text-fg">{phoneShort(d.customerPhone)}</span>
          <span className="font-mono text-[10px] text-faint">· {ago(d.createdAt)} ago</span>
        </div>
        <Chip color={chip.color} dot pulse={chip.pulse}>
          {chip.label}
        </Chip>
      </div>

      <div className="mt-3 flex items-center gap-2 font-display text-[17px] font-700 tracking-[0.02em] text-fg">
        <MapPin size={14} className="text-faint" />
        <span>{place(d.fromText, d.fromResolved)}</span>
        <ArrowRight size={15} className="text-amber" />
        <span>{place(d.toText, d.toResolved)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px]">
        <span className="font-mono text-muted">{d.channel === "whatsapp" ? "💬 WhatsApp" : d.channel === "console" ? "Console" : "📞 Call"}</span>
        {d.vehicleType && (
          <span className="flex items-center gap-1 font-mono text-muted">
            <Truck size={11} className="text-faint" /> {d.vehicleType}
          </span>
        )}
        {d.pickupDate && <span className="font-mono tnum text-muted">{d.pickupDate}</span>}
        <span className="font-mono text-muted">
          offer <span className="font-700 text-sky">{inr(d.offeredPriceInr)}</span>
        </span>
        {d.note && <span className="truncate text-faint">“{d.note}”</span>}
      </div>

      {/* the domino tracker */}
      {STEP_OF[d.status] !== -1 && (
        <div className="mt-4 overflow-x-auto border-t border-line/70 pt-3">
          <Domino status={d.status} />
        </div>
      )}

      {/* the one action this stage needs */}
      <div className="mt-4 border-t border-line/70 pt-3">
        {d.status === "NEW" && (
          <div className="flex items-end justify-between gap-2">
            <label>
              <span className="eyebrow mb-1 block">Source drivers at ₹</span>
              <input
                type="number"
                value={price || ""}
                onChange={(e) => setPrice(Number(e.target.value))}
                className="w-28 rounded-lg border border-line bg-panel2 px-2.5 py-1.5 text-right font-mono text-[13px] tnum text-fg focus:border-brand focus:bg-panel focus:outline-none focus:ring-4 focus:ring-brand/10"
              />
            </label>
            <div className="flex items-center gap-2">
              <Button variant="danger" disabled={!!busy} onClick={() => run("r", () => api.rejectDemand(d.id))}>
                <X size={13} /> {busy === "r" ? "…" : "Reject"}
              </Button>
              <Button
                variant="primary"
                disabled={!!busy}
                onClick={() => run("s", () => api.approveDemand(d.id, { fixedPriceInr: price || undefined }))}
              >
                <PhoneCall size={13} /> {busy === "s" ? "Calling…" : "Call drivers"}
              </Button>
            </div>
          </div>
        )}

        {d.status === "SOURCING" && (
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] text-muted">
              Drivers are being called at <span className="font-700 text-amber">{inr(d.offeredPriceInr)}</span> — watch the run on Dispatch.
            </span>
            <Button variant="ghost" disabled={!!busy} onClick={() => run("c", () => api.cancelDemand(d.id))}>
              <X size={13} /> Cancel
            </Button>
          </div>
        )}

        {d.status === "DRIVER_LOCKED" && (
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 font-mono text-[12px]">
              <Lock size={13} className="text-go" />
              <span className="text-muted">Driver locked at</span>
              <span className="font-700 tnum text-go">{inr(lockedPrice)}</span>
            </span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" disabled={!!busy} onClick={() => run("c", () => api.cancelDemand(d.id))}>
                <X size={13} /> Reject
              </Button>
              <Button variant="primary" disabled={!!busy} onClick={() => run("a", () => api.approveDriver(d.id))}>
                <Check size={13} /> {busy === "a" ? "…" : "Approve & call customer"}
              </Button>
            </div>
          </div>
        )}

        {d.status === "CUSTOMER_PENDING" && (
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[11px] text-muted">
              Confirming the customer at <span className="font-700 text-violet">{inr(lockedPrice)}</span>…
            </span>
            <div className="flex items-center gap-2">
              <Button variant="danger" disabled={!!busy} onClick={() => run("d", () => api.cancelDemand(d.id))}>
                <X size={13} /> Declined
              </Button>
              <Button variant="go" disabled={!!busy} onClick={() => run("b", () => api.bookDemand(d.id))}>
                <Check size={13} /> {busy === "b" ? "Booking…" : "Customer confirmed → Book"}
              </Button>
            </div>
          </div>
        )}

        {d.status === "BOOKED" && (
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 font-mono text-[12px] text-go">
              <Check size={14} /> Booked at <span className="font-700 tnum">{inr(lockedPrice)}</span>
            </span>
            <span className="font-mono text-[10px] text-faint">{d.bookedAt ? `${ago(d.bookedAt)} ago` : ""}</span>
          </div>
        )}

        {(d.status === "DECLINED" || d.status === "CANCELLED") && (
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] text-faint">{STATUS_CHIP[d.status].label}.</span>
            <Button variant="ghost" disabled={!!busy} onClick={() => run("re", () => api.resourceDemand(d.id))}>
              <RotateCw size={13} /> {busy === "re" ? "…" : "Re-source drivers"}
            </Button>
          </div>
        )}

        {d.status === "REJECTED" && <span className="font-mono text-[11px] text-faint">Rejected.</span>}
      </div>
    </Panel>
  );
}

// Order so the cards that need a human decision float to the top.
const PRIORITY: DemandStatus[] = [
  "DRIVER_LOCKED",
  "CUSTOMER_PENDING",
  "NEW",
  "SOURCING",
  "BOOKED",
  "DECLINED",
  "CANCELLED",
  "REJECTED",
];

export function InboundView(_props: { onSourced: () => void }) {
  const { data: demand, refresh } = usePolling(() => api.listDemand(), 4000, []);
  const list = (demand ?? []).slice().sort((a, b) => PRIORITY.indexOf(a.status) - PRIORITY.indexOf(b.status));
  const needsAction = list.filter((d) => d.status === "DRIVER_LOCKED" || d.status === "CUSTOMER_PENDING").length;

  return (
    <div className="mx-auto max-w-[1180px]">
      <Eyebrow>
        {needsAction} awaiting your decision · {list.length} total
      </Eyebrow>

      {list.length === 0 ? (
        <Panel className="mt-4">
          <Empty
            icon={<PhoneIncoming size={28} />}
            title="No inbound requests yet"
            hint="When a customer calls in, the agent captures their route and price here — then the domino auto-calls drivers."
          />
        </Panel>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {list.map((d) => (
            <DemandCard key={d.id} d={d} refresh={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}
