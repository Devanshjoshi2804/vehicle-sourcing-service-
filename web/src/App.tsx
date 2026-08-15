import { useEffect, useState } from "react";
import { Radar, Truck, PhoneIncoming, Activity, Megaphone } from "lucide-react";
import { api } from "./api/client";
import { usePolling } from "./hooks/usePolling";
import { DispatchView } from "./views/DispatchView";
import { DriversView } from "./views/DriversView";
import { InboundView } from "./views/InboundView";
import { OutreachView } from "./views/OutreachView";

type View = "dispatch" | "drivers" | "inbound" | "outreach";

const NAV: { id: View; label: string; icon: any; desc: string }[] = [
  { id: "dispatch", label: "Dispatch", icon: Radar, desc: "Post loads and work the lines" },
  { id: "drivers", label: "Drivers", icon: Truck, desc: "Vehicle roster and status" },
  { id: "inbound", label: "Inbound", icon: PhoneIncoming, desc: "Customer demand and approvals" },
  { id: "outreach", label: "Outreach", icon: Megaphone, desc: "Campaign funnel: WhatsApp → IVR → manual" },
];

function Clock() {
  const [t, setT] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-1.5 shadow-card">
      <span className="relative flex h-2 w-2">
        <span className="absolute h-2 w-2 rounded-full bg-go/50 animate-ping-ring" />
        <span className="h-2 w-2 rounded-full bg-go" />
      </span>
      <span className="font-mono text-[12px] tnum text-muted">
        {t.toLocaleTimeString("en-IN", { hour12: false })} IST
      </span>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>("dispatch");
  const { data: demand } = usePolling(() => api.listDemand(), 6000, []);
  const inboundCount = (demand ?? []).filter((d) =>
    ["NEW", "DRIVER_LOCKED", "CUSTOMER_PENDING"].includes(d.status),
  ).length;
  const active = NAV.find((n) => n.id === view)!;

  return (
    <div className="flex h-full">
      {/* rail */}
      <aside className="flex w-[244px] shrink-0 flex-col border-r border-line bg-panel">
        <div className="flex items-center gap-3 px-5 py-5">
          <div className="grid h-10 w-10 place-items-center rounded-2xl bg-brand text-white shadow-lift">
            <Radar size={19} strokeWidth={2.4} />
          </div>
          <div className="leading-tight">
            <div className="font-display text-[16px] font-800 tracking-[-0.01em] text-fg">Dispatch</div>
            <div className="font-mono text-[9px] font-600 uppercase tracking-[0.32em] text-brand">control</div>
          </div>
        </div>

        <nav className="mt-3 flex flex-col gap-1 px-3">
          {NAV.map((n) => {
            const on = view === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setView(n.id)}
                className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all ${
                  on ? "bg-brandSoft text-brand" : "text-muted hover:bg-panel2 hover:text-fg"
                }`}
              >
                {on && <span className="absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-brand" />}
                <n.icon size={18} className={on ? "text-brand" : "text-faint group-hover:text-muted"} />
                <span className="flex-1 font-display text-[13.5px] font-700">{n.label}</span>
                {n.id === "inbound" && inboundCount > 0 && (
                  <span className="grid h-5 min-w-5 place-items-center rounded-full bg-sky px-1.5 font-mono text-[10px] font-700 text-white">
                    {inboundCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="mt-auto m-3 rounded-xl border border-line bg-panel2 px-3.5 py-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute h-2 w-2 rounded-full bg-go/50 animate-ping-ring" />
              <span className="h-2 w-2 rounded-full bg-go" />
            </span>
            <span className="font-display text-[11px] font-700 text-fg">Agent online</span>
          </div>
          <div className="mt-1 truncate font-mono text-[10px] text-faint">
            {(import.meta.env.VITE_API_BASE as string)?.replace(/^https?:\/\//, "")}
          </div>
        </div>
      </aside>

      {/* main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-line bg-panel/70 px-7 py-4 backdrop-blur">
          <div>
            <div className="eyebrow flex items-center gap-1.5">
              <Activity size={11} className="text-brand" /> {active.desc}
            </div>
            <h1 className="mt-1 font-display text-[24px] font-800 tracking-[-0.02em] text-fg">{active.label}</h1>
          </div>
          <Clock />
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-7 py-6">
          {view === "dispatch" && <DispatchView />}
          {view === "drivers" && <DriversView />}
          {view === "inbound" && <InboundView onSourced={() => setView("dispatch")} />}
          {view === "outreach" && <OutreachView />}
        </main>
      </div>
    </div>
  );
}
