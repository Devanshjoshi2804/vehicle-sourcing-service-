import { Truck } from "lucide-react";

// Origin ●——→● destination — the signature motif. Reused in the manifest hero
// and the loads list so the "journey" reads at every scale.
export function RouteLine({
  from,
  to,
  tone = "dark",
  active = false,
  size = "sm",
}: {
  from: string;
  to: string;
  tone?: "dark" | "light";
  active?: boolean;
  size?: "sm" | "lg";
}) {
  const big = size === "lg";
  const light = tone === "light";
  const labelCls = light ? "text-white" : "text-fg";
  const stroke = light ? "rgba(255,255,255,0.45)" : "#C4D5CF";
  const fromDot = light ? "#FFFFFF" : "#0F766E";
  const toDot = "#E08600";

  return (
    <div className="flex items-center gap-3">
      <span className="flex items-center gap-2">
        <span
          className="shrink-0 rounded-full"
          style={{ background: fromDot, width: big ? 10 : 7, height: big ? 10 : 7 }}
        />
        <span className={`font-display ${big ? "text-[26px] font-700" : "text-[14px] font-600"} ${labelCls} tracking-[-0.01em]`}>
          {from}
        </span>
      </span>

      <span className="relative flex h-4 min-w-[40px] flex-1 items-center">
        <svg width="100%" height="4" className="overflow-visible">
          <line
            x1="0"
            y1="2"
            x2="100%"
            y2="2"
            stroke={stroke}
            strokeWidth="1.5"
            strokeDasharray="2 5"
            strokeLinecap="round"
            className={active ? "animate-dash" : ""}
          />
        </svg>
        {active && (
          <Truck
            size={big ? 16 : 12}
            className="absolute right-1 text-amber"
            style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.2))" }}
          />
        )}
      </span>

      <span className="flex items-center gap-2">
        <span className={`font-display ${big ? "text-[26px] font-700" : "text-[14px] font-600"} ${labelCls} tracking-[-0.01em]`}>
          {to}
        </span>
        <span
          className="shrink-0 rounded-full ring-2"
          style={{ background: toDot, width: big ? 10 : 7, height: big ? 10 : 7, ["--tw-ring-color" as any]: "rgba(224,134,0,0.25)" }}
        />
      </span>
    </div>
  );
}
