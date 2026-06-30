import { useEffect, useState } from "react";
import { Check, PhoneCall, Users } from "lucide-react";
import { api, Load } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { phoneShort } from "../lib/format";
import { Button, Chip, Empty } from "./ui";

// Signal strength = how well a transporter fits this lane+vehicle. Drawn as
// reception bars because that's the dispatcher's instinct: who do I call first.
function Bars({ score }: { score: number }) {
  const lit = Math.min(Math.max(score, 0), 3);
  return (
    <span className="flex h-4 items-end gap-[2px]" title={`match ${score}`}>
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          className={`w-[3px] rounded-full ${n <= lit ? "bg-amber" : "bg-line2"}`}
          style={{ height: `${5 + n * 3}px` }}
        />
      ))}
    </span>
  );
}

// "The Lane": the transporters who run this route, ranked, with a multi-select
// to fire the AI call run. Feeds The Line to its right.
export function TheLane({
  load,
  calledOwnerIds,
  onFired,
}: {
  load: Load;
  calledOwnerIds: Set<string>;
  onFired: () => void;
}) {
  const { data: suggestions } = usePolling(() => api.suggestedOwners(load.id), 10000, [load.id]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (suggestions) setSel(new Set(suggestions.map((s) => s.owner.id).filter((id) => !calledOwnerIds.has(id))));
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

  const fresh = (suggestions ?? []).filter((s) => !calledOwnerIds.has(s.owner.id)).length;

  return (
    <section className="card relative flex h-full flex-col overflow-hidden">
      <span className="absolute left-0 top-0 h-full w-[3px] bg-brand" />
      <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
        <div>
          <h2 className="font-display text-[13px] font-700 text-fg">The lane</h2>
          <div className="mt-0.5 font-mono text-[10px] font-600 uppercase tracking-[0.12em] text-faint">
            {load.fromLocation} → {load.toLocation} · {load.vehicleType}
          </div>
        </div>
        <Button variant="primary" onClick={fire} disabled={busy || sel.size === 0} className="!py-1.5 !text-[12px]">
          <PhoneCall size={13} /> {busy ? "Ringing…" : `Call ${sel.size}`}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {!suggestions || suggestions.length === 0 ? (
          <Empty
            icon={<Users size={22} />}
            title="No trucks on this lane yet"
            hint="Add transporters who run this route and vehicle on the Drivers screen — the matcher ranks them here."
          />
        ) : (
          <>
            {fresh > 0 && (
              <div className="border-b border-line bg-panel2/50 px-5 py-2 font-mono text-[10px] font-600 uppercase tracking-[0.12em] text-muted">
                {fresh} not yet called · {sel.size} selected
              </div>
            )}
            {suggestions.map(({ owner, score }) => {
              const called = calledOwnerIds.has(owner.id);
              const on = sel.has(owner.id);
              return (
                <button
                  key={owner.id}
                  onClick={() => toggle(owner.id)}
                  className={`flex w-full items-center gap-3 border-b border-line px-5 py-3 text-left transition-colors last:border-b-0 hover:bg-panel2 ${
                    called ? "opacity-60" : ""
                  }`}
                >
                  <span
                    className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-md border transition ${
                      on ? "border-brand bg-brand text-white" : "border-line2 bg-panel2"
                    }`}
                  >
                    {on && <Check size={12} strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-600 text-fg">{owner.name}</span>
                    <span className="font-mono text-[11px] tnum text-faint">{phoneShort(owner.phone)}</span>
                  </span>
                  {owner.vehicleTypes[0] && <Chip color="muted">{owner.vehicleTypes[0]}</Chip>}
                  {called && (
                    <Chip color="amber" dot>
                      called
                    </Chip>
                  )}
                  <Bars score={score} />
                </button>
              );
            })}
          </>
        )}
      </div>
    </section>
  );
}
