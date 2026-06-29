import { useEffect, useState } from "react";
import { Radar, Truck, PhoneIncoming, Activity } from "lucide-react";
import { api } from "./api/client";
import { usePolling } from "./hooks/usePolling";
import { DispatchView } from "./views/DispatchView";
import { DriversView } from "./views/DriversView";
import { InboundView } from "./views/InboundView";

type View = "dispatch" | "drivers" | "inbound";

const NAV: { id: View; label: string; icon: any; desc: string }[] = [
  { id: "dispatch", label: "Dispatch", icon: Radar, desc: "Post loads · work the lines" },
  { id: "drivers", label: "Drivers", icon: Truck, desc: "Vehicle roster · status" },
  { id: "inbound", label: "Inbound", icon: PhoneIncoming, desc: "Customer demand · approve" },
];

function Clock() {
  const [t, setT] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="font-mono text-[12px] tnum text-muted">
      {t.toLocaleTimeString("en-IN", { hour12: false })} IST
    </span>
  );
}

export default function App() {
  const [view, setView] = useState<View>("dispatch");

  // light global poll for the inbound badge
  const { data: newDemand } = usePolling(() => api.listDemand("NEW"), 6000, []);
  const inboundCount = newDemand?.length ?? 0;

  const active = NAV.find((n) => n.id === view)!;

  return (
    <div className="flex h-full">
      {/* rail */}
      <aside className="flex w-[230px] shrink-0 flex-col border-r border-line bg-panel/50">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-amber text-ink shadow-[0_0_24px_-6px_rgba(255,176,32,0.7)]">
            <Radar size={18} strokeWidth={2.4} />
          </div>
          <div className="leading-tight">
            <div className="font-display text-[15px] font-800 uppercase tracking-[0.1em] text-fg">
              Dispatch
            </div>
            <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-amber">
              control
            </div>
          </div>
        </div>

        <nav className="mt-2 flex flex-col gap-1 px-3">
          {NAV.map((n) => {
            const on = view === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setView(n.id)}
                className={`group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-all ${
                  on ? "bg-panel2 text-fg" : "text-muted hover:bg-panel2/50 hover:text-fg"
                }`}
              >
                {on && <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-amber" />}
                <n.icon size={17} className={on ? "text-amber" : "text-faint group-hover:text-muted"} />
                <span className="flex-1 font-display text-[13px] font-600 uppercase tracking-[0.08em]">
                  {n.label}
                </span>
                {n.id === "inbound" && inboundCount > 0 && (
                  <span className="grid h-5 min-w-5 place-items-center rounded-full bg-cyan px-1.5 font-mono text-[10px] font-700 text-ink">
                    {inboundCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="mt-auto px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute h-2 w-2 rounded-full bg-go/60 animate-ping-ring" />
              <span className="h-2 w-2 rounded-full bg-go" />
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
              Live · agent online
            </span>
          </div>
          <div className="mt-1 truncate font-mono text-[10px] text-faint">
            {(import.meta.env.VITE_API_BASE as string)?.replace(/^https?:\/\//, "")}
          </div>
        </div>
      </aside>

      {/* main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-line px-6 py-4">
          <div>
            <div className="eyebrow flex items-center gap-2">
              <Activity size={11} className="text-amber" /> {active.desc}
            </div>
            <h1 className="mt-0.5 font-display text-[22px] font-700 uppercase tracking-[0.06em] text-fg">
              {active.label}
            </h1>
          </div>
          <Clock />
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-6 py-5">
          {view === "dispatch" && <DispatchView />}
          {view === "drivers" && <DriversView />}
          {view === "inbound" && <InboundView onSourced={() => setView("dispatch")} />}
        </main>
      </div>
    </div>
  );
}
