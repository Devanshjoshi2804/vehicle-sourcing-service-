import { useState } from "react";
import { Phone, Check, TrendingUp, X, RotateCw, Truck, Radio, Lock, ArrowRight } from "lucide-react";
import { CallAttempt, DemandStatus, Load, Owner, Quote } from "../api/client";
import { inr, phoneShort } from "../lib/format";
import { Button, Chip, Empty } from "./ui";

type Outcome =
  | "QUEUED"
  | "DIALING"
  | "ON_CALL"
  | "ACCEPTED"
  | "COUNTER"
  | "CALLBACK"
  | "DECLINED"
  | "NO_ANSWER";

export function resolveOutcome(call: CallAttempt, quote?: Quote): Outcome {
  if (quote) {
    if (quote.available === "NO") return "DECLINED";
    if (quote.available === "CALLBACK") return "CALLBACK";
    if (quote.available === "YES") return quote.acceptsFixed ? "ACCEPTED" : "COUNTER";
  }
  if (call.status === "NO_ANSWER" || call.status === "FAILED") return "NO_ANSWER";
  if (call.status === "QUEUED") return "QUEUED";
  if (call.status === "DIALING") return "DIALING";
  return "ON_CALL";
}

const META: Record<Outcome, { label: string; color: any; accent: string; tint: string }> = {
  QUEUED: { label: "Queued", color: "muted", accent: "transparent", tint: "" },
  DIALING: { label: "Ringing", color: "amber", accent: "#E08600", tint: "bg-amberSoft/40" },
  ON_CALL: { label: "On call", color: "amber", accent: "#E08600", tint: "bg-amberSoft/40" },
  ACCEPTED: { label: "Accepted", color: "go", accent: "#1B873F", tint: "bg-goSoft/50" },
  COUNTER: { label: "Counter", color: "amber", accent: "#E08600", tint: "" },
  CALLBACK: { label: "Call back", color: "sky", accent: "#0A7EA4", tint: "" },
  DECLINED: { label: "Declined", color: "rose", accent: "transparent", tint: "" },
  NO_ANSWER: { label: "No answer", color: "muted", accent: "transparent", tint: "" },
};

function Waveform() {
  return (
    <span className="flex h-4 items-end gap-[3px]">
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className="w-[3px] origin-bottom rounded-full bg-amber animate-bar"
          style={{ height: "100%", animationDelay: `${i * 0.12}s` }}
        />
      ))}
    </span>
  );
}

function Dialer() {
  return (
    <span className="relative flex h-3 w-3 items-center justify-center">
      <span className="absolute h-3 w-3 rounded-full bg-amber/50 animate-ping-ring" />
      <span className="h-2.5 w-2.5 rounded-full bg-amber animate-pulse-dot" />
    </span>
  );
}

function OutcomeChip({ o }: { o: Outcome }) {
  const m = META[o];
  const icon =
    o === "ACCEPTED" ? <Check size={11} /> : o === "COUNTER" ? <TrendingUp size={11} /> : o === "DECLINED" ? <X size={11} /> : null;
  return (
    <Chip color={m.color} dot pulse={o === "DIALING" || o === "ON_CALL"}>
      {icon}
      {m.label}
    </Chip>
  );
}

function CallStrip({
  call,
  owner,
  quote,
  fixedPrice,
  onFollowup,
  onAccept,
  i,
}: {
  call: CallAttempt;
  owner?: Owner;
  quote?: Quote;
  fixedPrice: number;
  onFollowup: (ownerId: string) => void;
  onAccept: (ownerId: string, priceInr: number) => void;
  i: number;
}) {
  const o = resolveOutcome(call, quote);
  const m = META[o];
  const active = o === "DIALING" || o === "ON_CALL";
  // editable accept price — prefilled with the driver's counter, but the dispatcher
  // can negotiate to any value (e.g. meet in the middle) before locking.
  const [acceptPrice, setAcceptPrice] = useState<number>(quote?.quotedPriceInr ?? fixedPrice);

  return (
    <div
      className={`group relative flex flex-col border-b border-line px-5 py-3.5 animate-fade-up transition-colors last:border-b-0 hover:bg-panel2 ${m.tint}`}
      style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}
    >
      <span className="absolute left-0 top-0 h-full w-[3px]" style={{ background: m.accent }} />

      {/* main row: who + status + their number */}
      <div className="flex items-center gap-3.5">
        <div
          className={`relative grid h-10 w-10 shrink-0 place-items-center rounded-xl border ${
            active ? "border-amber/30 bg-amberSoft" : "border-line bg-panel2"
          }`}
        >
          {active ? <Dialer /> : <Phone size={15} className="text-faint" />}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-700 text-fg">{owner?.name ?? "Driver"}</span>
            {call.flow === "fixed_price_followup" && (
              <span className="shrink-0 font-mono text-[9px] font-600 uppercase tracking-[0.12em] text-amber">· holding</span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2.5 font-mono text-[11px] text-muted tnum">
            <span>{phoneShort(call.phone)}</span>
            {owner?.vehicleTypes?.[0] && (
              <span className="flex items-center gap-1 text-faint">
                <Truck size={11} /> {owner.vehicleTypes[0]}
              </span>
            )}
          </div>
        </div>

        {o === "ON_CALL" && <div className="hidden w-12 justify-center sm:flex">{<Waveform />}</div>}

        <div className="flex shrink-0 items-center gap-3">
          {o === "ACCEPTED" && <span className="font-mono text-[16px] font-700 tnum text-go">{inr(fixedPrice)}</span>}
          {o === "COUNTER" && (
            <span className="text-right font-mono tnum leading-tight">
              <span className="block text-[15px] font-700 text-amber">{inr(quote?.quotedPriceInr)}</span>
              <span className="text-[10px] text-faint line-through">{inr(fixedPrice)}</span>
            </span>
          )}
          <OutcomeChip o={o} />
        </div>
      </div>

      {/* action row (counter only): negotiate a price, then accept or hold */}
      {o === "COUNTER" && (
        <div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5 pl-[54px]">
          <span className="mr-auto font-mono text-[10px] uppercase tracking-[0.1em] text-faint">Lock at</span>
          <div className="flex items-center rounded-lg border border-go/30 bg-goSoft/40 pl-2">
            <span className="font-mono text-[12px] text-go">₹</span>
            <input
              type="number"
              value={acceptPrice || ""}
              onChange={(e) => setAcceptPrice(Number(e.target.value))}
              className="w-[70px] bg-transparent px-1 py-1.5 font-mono text-[12px] tnum text-go focus:outline-none"
              title="Set the price to lock this driver at"
            />
          </div>
          <Button
            variant="go"
            className="!rounded-lg !px-2.5 !py-1.5 !text-[11px]"
            onClick={() => owner && acceptPrice > 0 && onAccept(owner.id, acceptPrice)}
            title="Lock this driver at the price shown"
          >
            <Check size={12} /> Accept
          </Button>
          <Button
            variant="amber"
            className="!rounded-lg !px-2.5 !py-1.5 !text-[11px]"
            onClick={() => owner && onFollowup(owner.id)}
            title="Call back and hold the fixed price"
          >
            <RotateCw size={12} /> Hold {inr(fixedPrice)}
          </Button>
        </div>
      )}
    </div>
  );
}

export function TheLine({
  load,
  calls,
  quotes,
  owners,
  demandStatus,
  onFollowup,
  onAccept,
  onClose,
}: {
  load: Load;
  calls: CallAttempt[];
  quotes: Quote[];
  owners: Owner[];
  demandStatus?: DemandStatus | null;
  onFollowup: (ownerId: string) => void;
  onAccept: (ownerId: string, priceInr: number) => void;
  onClose: () => void;
}) {
  const ownerById = new Map(owners.map((o) => [o.id, o]));
  const quoteFor = (c: CallAttempt) =>
    quotes
      .filter((q) => q.callAttemptId === c.id || (c.elConversationId && q.elConversationId === c.elConversationId))
      .slice(-1)[0];

  const latestByOwner = new Map<string, CallAttempt>();
  for (const c of calls) {
    const prev = latestByOwner.get(c.ownerId);
    if (!prev || new Date(c.createdAt) >= new Date(prev.createdAt)) latestByOwner.set(c.ownerId, c);
  }
  const strips = [...latestByOwner.values()].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));

  const active = strips.filter((c) => ["DIALING", "ON_CALL"].includes(resolveOutcome(c, quoteFor(c)))).length;
  const won = strips.find((c) => resolveOutcome(c, quoteFor(c)) === "ACCEPTED");
  const wonOwner = won ? ownerById.get(won.ownerId) : undefined;
  const closed = load.status === "CLOSED";
  const booked = load.status === "BOOKED" || demandStatus === "BOOKED";
  const isDemand = demandStatus != null;
  const showLock = !!wonOwner || load.status === "LOCKED" || booked;
  // For a customer demand, the rest of the domino (approve value → confirm
  // customer → book) is driven from the Inbound board — keep one source of truth.
  const demandHint =
    demandStatus === "DRIVER_LOCKED"
      ? "Approve the value on Inbound to call the customer"
      : demandStatus === "CUSTOMER_PENDING"
        ? "Confirming the customer…"
        : demandStatus === "DECLINED" || demandStatus === "CANCELLED"
          ? "Cancelled — re-source from Inbound"
          : "";

  return (
    <section className="card relative flex h-full flex-col overflow-hidden">
      <span className="absolute left-0 top-0 h-full w-[3px] bg-amber" />
      {active > 0 && (
        <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 opacity-[0.07]">
          <div
            className="h-full w-full animate-sweep"
            style={{ background: "conic-gradient(from 0deg, transparent 0deg, #E08600 30deg, transparent 60deg)", borderRadius: "9999px" }}
          />
        </div>
      )}

      <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <Radio size={16} className={active > 0 ? "text-amber" : "text-faint"} />
          <div>
            <h2 className="font-display text-[13px] font-700 text-fg">The line</h2>
            <div className="mt-0.5 font-mono text-[10px] font-600 uppercase tracking-[0.12em] text-faint">working now</div>
          </div>
        </div>
        {active > 0 && (
          <Chip color="amber" dot pulse>
            {active} on air
          </Chip>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {strips.length === 0 ? (
          <Empty
            icon={<Radio size={24} />}
            title="The line is quiet"
            hint="Pick trucks on the lane and start the run — every call lands here live as the agent holds your fixed freight."
          />
        ) : (
          strips.map((c, i) => (
            <CallStrip
              key={c.id}
              call={c}
              owner={ownerById.get(c.ownerId)}
              quote={quoteFor(c)}
              fixedPrice={load.fixedPriceInr}
              onFollowup={onFollowup}
              onAccept={onAccept}
              i={i}
            />
          ))
        )}
      </div>

      {/* terminal state — a truck took the fixed freight, the docket is locked */}
      {showLock && (
        <div
          className={`flex items-center gap-3 border-t-2 px-5 py-3.5 ${
            booked ? "border-violet/30 bg-violetSoft/60" : "border-go/30 bg-goSoft/60"
          }`}
        >
          <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white ${booked ? "bg-violet" : "bg-go"}`}>
            {booked ? <Check size={16} /> : <Lock size={15} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className={`font-mono text-[10px] font-600 uppercase tracking-[0.14em] ${booked ? "text-violet" : "text-go"}`}>
              {booked ? "Trip booked" : "Driver locked at fixed freight"}
            </div>
            <div className="truncate text-[14px] font-700 text-fg">
              {wonOwner?.name ?? "Driver"} · <span className={`font-mono tnum ${booked ? "text-violet" : "text-go"}`}>{inr(load.fixedPriceInr)}</span>
            </div>
          </div>
          {/* Side-B load (no customer): dispatcher just closes it. */}
          {!isDemand && !closed && !booked && (
            <Button variant="go" onClick={onClose} className="!py-1.5 !text-[12px]">
              <Check size={13} /> Close load
            </Button>
          )}
          {!isDemand && closed && <Chip color="go" dot>closed</Chip>}
          {/* Demand-sourced load: next steps live on the Inbound board. */}
          {isDemand && !booked && demandHint && (
            <span className="flex items-center gap-1.5 font-mono text-[11px] font-600 text-go">
              {demandHint} <ArrowRight size={12} />
            </span>
          )}
          {booked && <Chip color="violet" dot>booked</Chip>}
        </div>
      )}
    </section>
  );
}
