import { Truck, CalendarDays } from "lucide-react";
import { Load } from "../api/client";
import { inr } from "../lib/format";
import { RouteLine } from "./RouteLine";
import { Stamp } from "./Stamp";

export type Run = {
  called: number;
  dialing: number;
  onCall: number;
  holding: number;
  accepted: number;
  declined: number;
  winner?: string;
};

// A short human code for the load — dispatchers call loads by a ticket number,
// not a uuid. Derived deterministically from the id so it's stable per load.
function ticketNo(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(36).toUpperCase().slice(0, 4).padStart(4, "0");
}

// The load rendered as a freight docket (LR/bilty): the one thing every dispatch
// is about. Perforated stub at the bottom carries the live run state; the rubber
// stamp on the right is the at-a-glance status the dispatcher reads first.
export function LoadDocket({
  load,
  run,
  locked,
  lockedPrice,
}: {
  load: Load;
  run: Run;
  locked: boolean;
  lockedPrice?: number | null;
}) {
  const calling = load.status === "CALLING";
  const booked = load.status === "BOOKED";
  // Once locked/booked, show the price actually agreed (may differ from the fixed
  // offer after a negotiation), with the original fixed struck through beside it.
  const negotiated = (locked || booked) && lockedPrice != null && lockedPrice !== load.fixedPriceInr;
  const shownPrice = locked || booked ? (lockedPrice ?? load.fixedPriceInr) : load.fixedPriceInr;
  const priceLabel = booked ? "Booked at" : negotiated ? "Agreed freight" : "Fixed freight";
  return (
    <section className="relative overflow-hidden rounded-2xl shadow-hero">
      <div className="absolute inset-0 bg-gradient-to-br from-deep via-deep2 to-deep" />
      {/* ambient amber sweep while the line is live */}
      {(run.dialing + run.onCall) > 0 && (
        <div className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 opacity-[0.10]">
          <div
            className="h-full w-full animate-sweep rounded-full"
            style={{ background: "conic-gradient(from 0deg, transparent 0deg, #E08600 28deg, transparent 56deg)" }}
          />
        </div>
      )}

      {/* body */}
      <div className="relative px-6 pb-5 pt-5">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <span className="rounded-md border border-white/15 bg-white/5 px-2 py-0.5 font-mono text-[11px] font-700 tracking-[0.12em] text-white/80">
                LOAD #{ticketNo(load.id)}
              </span>
              <span className="font-mono text-[10px] font-600 uppercase tracking-[0.22em] text-white/40">
                {locked ? "sourced" : "sourcing a truck"}
              </span>
            </div>

            <div className="mt-4 max-w-[520px]">
              <RouteLine from={load.fromLocation} to={load.toLocation} tone="light" active={calling} size="lg" />
            </div>
            <div className="mt-3 flex items-center gap-4 text-[12px] text-white/60">
              <span className="flex items-center gap-1.5 font-mono">
                <Truck size={13} className="text-white/45" /> {load.vehicleType}
              </span>
              <span className="flex items-center gap-1.5 font-mono tnum">
                <CalendarDays size={13} className="text-white/45" /> {load.pickupDate}
              </span>
            </div>
          </div>

          {/* fixed freight + stamp */}
          <div className="flex flex-col items-end gap-3">
            <Stamp status={load.status} locked={locked} />
            <div className="text-right">
              <div className={`font-mono text-[10px] font-600 uppercase tracking-[0.2em] ${booked ? "text-white/70" : "text-amber/90"}`}>
                {priceLabel}
              </div>
              <div className="font-mono text-[40px] font-700 leading-none tracking-[-0.02em] text-white tnum">
                {inr(shownPrice)}
              </div>
              {negotiated && (
                <div className="mt-0.5 font-mono text-[11px] tnum text-white/45 line-through">{inr(load.fixedPriceInr)}</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* perforation seam with punched notches — the ticket tears here */}
      <div className="relative">
        <div className="mx-6 border-t border-dashed border-white/20" />
        <span className="absolute -left-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-canvas" />
        <span className="absolute -right-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-canvas" />
      </div>

      {/* run stub — the live ledger, read left to right as the call run unfolds */}
      <div className="relative flex flex-wrap items-center gap-x-5 gap-y-1 px-6 py-3">
        <Tick label="called" value={run.called} tone="text-white/80" />
        <Sep />
        <Tick label="on the line" value={run.dialing + run.onCall} tone="text-amber" live={run.dialing + run.onCall > 0} />
        <Sep />
        <Tick label="holding price" value={run.holding} tone="text-amber/90" />
        <Sep />
        <Tick
          label={run.winner ? "locked" : "accepted"}
          value={run.winner ?? run.accepted}
          tone="text-go"
          go={!!run.winner}
        />
      </div>
    </section>
  );
}

function Sep() {
  return <span className="h-3 w-px bg-white/12" />;
}

function Tick({
  label,
  value,
  tone,
  live,
  go,
}: {
  label: string;
  value: React.ReactNode;
  tone: string;
  live?: boolean;
  go?: boolean;
}) {
  return (
    <span key={String(value)} className="flex animate-ticker-in items-center gap-2">
      <span className={`h-1.5 w-1.5 rounded-full ${go ? "bg-go" : live ? "bg-amber animate-pulse-dot" : "bg-white/25"}`} />
      <span className={`font-mono text-[14px] font-700 leading-none tnum ${tone}`}>{value}</span>
      <span className="font-mono text-[10px] font-600 uppercase tracking-[0.14em] text-white/40">{label}</span>
    </span>
  );
}
