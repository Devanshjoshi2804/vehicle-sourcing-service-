import { Phone, Check, TrendingUp, X, RotateCw, Truck, Radio } from "lucide-react";
import { CallAttempt, Load, Owner, Quote } from "../api/client";
import { inr, phoneShort, place } from "../lib/format";
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

function resolve(call: CallAttempt, quote?: Quote): Outcome {
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

const META: Record<Outcome, { label: string; color: any }> = {
  QUEUED: { label: "Queued", color: "muted" },
  DIALING: { label: "Dialing", color: "amber" },
  ON_CALL: { label: "On call", color: "amber" },
  ACCEPTED: { label: "Accepted", color: "go" },
  COUNTER: { label: "Counter", color: "amber" },
  CALLBACK: { label: "Call back", color: "cyan" },
  DECLINED: { label: "Declined", color: "rose" },
  NO_ANSWER: { label: "No answer", color: "muted" },
};

function Waveform() {
  return (
    <span className="flex h-4 items-end gap-[2px]">
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className="w-[2px] origin-bottom rounded-full bg-amber animate-bar"
          style={{ height: "100%", animationDelay: `${i * 0.12}s` }}
        />
      ))}
    </span>
  );
}

function Dialer() {
  return (
    <span className="relative flex h-2.5 w-2.5 items-center justify-center">
      <span className="absolute h-2.5 w-2.5 rounded-full bg-amber/60 animate-ping-ring" />
      <span className="h-2 w-2 rounded-full bg-amber animate-pulse-dot" />
    </span>
  );
}

function CallStrip({
  call,
  owner,
  quote,
  fixedPrice,
  onFollowup,
  i,
}: {
  call: CallAttempt;
  owner?: Owner;
  quote?: Quote;
  fixedPrice: number;
  onFollowup: (ownerId: string) => void;
  i: number;
}) {
  const o = resolve(call, quote);
  const m = META[o];
  const active = o === "DIALING" || o === "ON_CALL";
  const live = call.flow === "fixed_price_followup";

  return (
    <div
      className="group flex items-center gap-3 border-b border-line/70 px-4 py-3 animate-fade-up transition-colors hover:bg-panel2/40"
      style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
    >
      {/* dialer / avatar */}
      <div
        className={`relative grid h-9 w-9 shrink-0 place-items-center rounded-lg border ${
          active ? "border-amber/40 bg-amber/10" : "border-line2 bg-ink/50"
        }`}
      >
        {active ? <Dialer /> : <Phone size={14} className="text-faint" />}
      </div>

      {/* identity */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-600 text-fg">
            {owner?.name ?? "Driver"}
          </span>
          {live && (
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-amber">
              · hold price
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-muted tnum">
          <span>{phoneShort(call.phone)}</span>
          {owner?.vehicleTypes?.[0] && (
            <span className="flex items-center gap-1 text-faint">
              <Truck size={11} /> {owner.vehicleTypes[0]}
            </span>
          )}
        </div>
      </div>

      {/* live signal */}
      <div className="hidden w-16 justify-center sm:flex">
        {o === "ON_CALL" && <Waveform />}
      </div>

      {/* price / outcome */}
      <div className="flex items-center gap-3">
        {o === "ACCEPTED" && (
          <span className="font-mono text-[15px] font-700 tnum text-go">{inr(fixedPrice)}</span>
        )}
        {o === "COUNTER" && (
          <span className="text-right font-mono tnum leading-tight">
            <span className="block text-[15px] font-700 text-amber">
              {inr(quote?.quotedPriceInr)}
            </span>
            <span className="text-[10px] text-faint line-through">{inr(fixedPrice)}</span>
          </span>
        )}

        <div className="w-[88px] text-right">
          <OutcomeChip o={o} />
        </div>

        {/* counter → hold the line action */}
        {o === "COUNTER" ? (
          <Button
            variant="amber"
            className="!px-2.5 !py-1.5 !text-[11px]"
            onClick={() => owner && onFollowup(owner.id)}
            title="Call back and hold the fixed price"
          >
            <RotateCw size={12} /> Hold ₹{fixedPrice.toLocaleString("en-IN")}
          </Button>
        ) : (
          <div className="w-[112px]" />
        )}
      </div>
    </div>
  );
}

function OutcomeChip({ o }: { o: Outcome }) {
  const m = META[o];
  const icon =
    o === "ACCEPTED" ? (
      <Check size={11} />
    ) : o === "COUNTER" ? (
      <TrendingUp size={11} />
    ) : o === "DECLINED" ? (
      <X size={11} />
    ) : null;
  return (
    <Chip color={m.color} dot pulse={o === "DIALING" || o === "ON_CALL"}>
      {icon}
      {m.label}
    </Chip>
  );
}

export function CallBoard({
  load,
  calls,
  quotes,
  owners,
  onFollowup,
}: {
  load: Load;
  calls: CallAttempt[];
  quotes: Quote[];
  owners: Owner[];
  onFollowup: (ownerId: string) => void;
}) {
  const ownerById = new Map(owners.map((o) => [o.id, o]));
  // latest quote per call attempt (match by callAttemptId, else conversation id)
  const quoteFor = (c: CallAttempt) =>
    quotes
      .filter((q) => q.callAttemptId === c.id || (c.elConversationId && q.elConversationId === c.elConversationId))
      .slice(-1)[0];

  // newest attempt per owner wins (a followup supersedes the offer)
  const latestByOwner = new Map<string, CallAttempt>();
  for (const c of calls) {
    const prev = latestByOwner.get(c.ownerId);
    if (!prev || new Date(c.createdAt) >= new Date(prev.createdAt)) latestByOwner.set(c.ownerId, c);
  }
  const strips = [...latestByOwner.values()].sort(
    (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt),
  );

  const active = strips.filter((c) => {
    const o = resolve(c, quoteFor(c));
    return o === "DIALING" || o === "ON_CALL";
  }).length;
  const accepted = strips.filter((c) => resolve(c, quoteFor(c)) === "ACCEPTED").length;

  return (
    <section className="panel relative flex h-full flex-col overflow-hidden" >
      <span className="absolute left-0 top-0 h-full w-[3px] bg-amber" />
      {/* ambient radar sweep when calls are live */}
      {active > 0 && (
        <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 opacity-[0.12]">
          <div
            className="h-full w-full animate-sweep"
            style={{
              background:
                "conic-gradient(from 0deg, transparent 0deg, rgba(255,176,32,0.9) 30deg, transparent 60deg)",
              borderRadius: "9999px",
            }}
          />
        </div>
      )}

      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Radio size={15} className={active > 0 ? "text-amber" : "text-faint"} />
          <h2 className="font-display text-[13px] font-700 uppercase tracking-[0.14em] text-fg">
            Live Call Board
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {active > 0 && (
            <Chip color="amber" dot pulse>
              {active} on air
            </Chip>
          )}
          {accepted > 0 && (
            <Chip color="go" dot>
              {accepted} accepted
            </Chip>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {strips.length === 0 ? (
          <Empty
            icon={<Radio size={28} />}
            title="No calls placed"
            hint="Pick drivers and start the run — each call appears here live as the agent works the line."
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
              i={i}
            />
          ))
        )}
      </div>
    </section>
  );
}
