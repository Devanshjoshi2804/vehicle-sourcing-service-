import { LoadStatus } from "../api/client";

// The signature mark: a rubber stamp that thuds onto the load docket and changes
// with the run — DRAFT → CALLING → LOCKED/CLOSED. Lives only on the dark docket,
// so every tone is tuned to read on deep petrol. Re-keys on status so the stamp
// re-lands (animation replays) whenever the load's state actually changes.
const FACE: Record<string, { label: string; ink: string; glow: string }> = {
  DRAFT: { label: "Draft", ink: "#9FB7B1", glow: "rgba(159,183,177,0.0)" },
  CALLING: { label: "On the line", ink: "#F0A12E", glow: "rgba(224,134,0,0.22)" },
  LOCKED: { label: "Locked", ink: "#54D08A", glow: "rgba(27,135,63,0.28)" },
  CLOSED: { label: "Closed", ink: "#7FA39C", glow: "rgba(127,163,156,0.0)" },
};

export function Stamp({ status, locked }: { status: LoadStatus; locked?: boolean }) {
  const key = locked ? "LOCKED" : status;
  const f = FACE[key] ?? FACE.DRAFT;
  return (
    <div
      key={key}
      className="animate-stamp-in select-none"
      style={{ color: f.ink, filter: `drop-shadow(0 2px 10px ${f.glow})` }}
    >
      <div
        className="relative grid place-items-center rounded-[7px] px-4 py-1.5"
        style={{
          border: `2.5px solid ${f.ink}`,
          boxShadow: `inset 0 0 0 2px ${f.ink}`,
          opacity: 0.92,
        }}
      >
        {/* ink breakup — faint diagonal wash so it reads as pressed, not printed */}
        <span
          className="pointer-events-none absolute inset-0 rounded-[7px] mix-blend-overlay"
          style={{
            backgroundImage:
              "repeating-linear-gradient(125deg, rgba(0,0,0,0.18) 0 1px, transparent 1px 4px)",
          }}
        />
        <span className="font-display text-[15px] font-800 uppercase leading-none tracking-[0.16em]">
          {f.label}
        </span>
      </div>
    </div>
  );
}
