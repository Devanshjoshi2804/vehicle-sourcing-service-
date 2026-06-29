import { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes } from "react";

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="eyebrow">{children}</div>;
}

export function Panel({
  children,
  className = "",
  title,
  right,
  accent,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  right?: ReactNode;
  accent?: string;
}) {
  return (
    <section className={`panel relative overflow-hidden ${className}`}>
      {accent && (
        <span
          className="absolute left-0 top-0 h-full w-[3px]"
          style={{ background: accent }}
        />
      )}
      {(title || right) && (
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="font-display text-[13px] font-700 uppercase tracking-[0.14em] text-fg">
            {title}
          </h2>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Button({
  children,
  variant = "ghost",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "amber" | "ghost" | "go" | "danger";
}) {
  const styles: Record<string, string> = {
    amber:
      "bg-amber text-ink font-600 hover:brightness-110 shadow-[0_0_0_1px_rgba(255,176,32,0.4),0_8px_24px_-8px_rgba(255,176,32,0.5)]",
    go: "bg-go/15 text-go border border-go/30 hover:bg-go/25",
    danger: "bg-rose/10 text-rose border border-rose/25 hover:bg-rose/20",
    ghost: "border border-line2 text-fg hover:bg-panel2 hover:border-faint",
  };
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-500 transition-all disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/60 ${styles[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="eyebrow mb-1.5 block">{label}</span>
      <input
        className="w-full rounded-lg border border-line bg-ink/60 px-3 py-2 text-[13px] text-fg placeholder:text-faint focus:border-amber/60 focus:outline-none focus:ring-1 focus:ring-amber/40 tnum"
        {...rest}
      />
    </label>
  );
}

export function Stat({
  label,
  value,
  tone = "fg",
  sub,
}: {
  label: string;
  value: ReactNode;
  tone?: string;
  sub?: ReactNode;
}) {
  const colors: Record<string, string> = {
    fg: "text-fg",
    amber: "text-amber",
    go: "text-go",
    cyan: "text-cyan",
    violet: "text-violet",
    rose: "text-rose",
  };
  return (
    <div className="px-4 py-3">
      <div className="eyebrow">{label}</div>
      <div className={`mt-1 font-mono text-2xl font-700 tnum leading-none ${colors[tone]}`}>
        {value}
      </div>
      {sub && <div className="mt-1 text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

export function Chip({
  children,
  color = "muted",
  dot,
  pulse,
}: {
  children: ReactNode;
  color?: "muted" | "amber" | "go" | "rose" | "cyan" | "violet";
  dot?: boolean;
  pulse?: boolean;
}) {
  const map: Record<string, string> = {
    muted: "text-muted border-line2 bg-panel2",
    amber: "text-amber border-amber/30 bg-amber/10",
    go: "text-go border-go/30 bg-go/10",
    rose: "text-rose border-rose/30 bg-rose/10",
    cyan: "text-cyan border-cyan/30 bg-cyan/10",
    violet: "text-violet border-violet/30 bg-violet/10",
  };
  const dotColor: Record<string, string> = {
    muted: "bg-faint",
    amber: "bg-amber",
    go: "bg-go",
    rose: "bg-rose",
    cyan: "bg-cyan",
    violet: "bg-violet",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[10px] font-600 uppercase tracking-[0.1em] ${map[color]}`}
    >
      {dot && (
        <span
          className={`h-1.5 w-1.5 rounded-full ${dotColor[color]} ${pulse ? "animate-pulse-dot" : ""}`}
        />
      )}
      {children}
    </span>
  );
}

export function Empty({ icon, title, hint }: { icon: ReactNode; title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <div className="text-faint">{icon}</div>
      <div className="font-display text-[13px] font-600 uppercase tracking-[0.14em] text-muted">
        {title}
      </div>
      <div className="max-w-[280px] text-[12px] text-faint">{hint}</div>
    </div>
  );
}
