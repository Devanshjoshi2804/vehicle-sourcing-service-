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
    <section className={`card relative overflow-hidden ${className}`}>
      {accent && <span className="absolute left-0 top-0 h-full w-[3px]" style={{ background: accent }} />}
      {(title || right) && (
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="font-display text-[13px] font-700 tracking-[0.01em] text-fg">{title}</h2>
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
  variant?: "primary" | "amber" | "ghost" | "go" | "danger";
}) {
  const styles: Record<string, string> = {
    primary:
      "bg-brand text-white font-600 shadow-[0_1px_2px_rgba(11,31,27,0.18)] hover:bg-brandDeep hover:shadow-cardhover active:brightness-95",
    amber: "bg-amber text-white font-600 hover:brightness-105 shadow-[0_1px_2px_rgba(11,31,27,0.15)]",
    go: "bg-goSoft text-go font-600 border border-go/20 hover:bg-go/15",
    danger: "bg-roseSoft text-rose font-600 border border-rose/20 hover:bg-rose/12",
    ghost: "bg-panel text-muted border border-line hover:bg-panel2 hover:text-fg hover:border-line2",
  };
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-3.5 py-2 text-[13px] transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-1 ${styles[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

const inputBase =
  "w-full rounded-xl border border-line bg-panel2 px-3 py-2.5 text-[14px] text-fg placeholder:text-faint transition focus:border-brand focus:bg-panel focus:outline-none focus:ring-4 focus:ring-brand/10";

export function Field({
  label,
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="eyebrow mb-1.5 block">{label}</span>
      <input className={`${inputBase} tnum`} {...rest} />
    </label>
  );
}
export { inputBase };

export function Stat({
  label,
  value,
  tone = "fg",
  icon,
}: {
  label: string;
  value: ReactNode;
  tone?: "fg" | "brand" | "amber" | "go" | "sky" | "violet" | "rose";
  icon?: ReactNode;
}) {
  const colors: Record<string, string> = {
    fg: "text-fg",
    brand: "text-brand",
    amber: "text-amber",
    go: "text-go",
    sky: "text-sky",
    violet: "text-violet",
    rose: "text-rose",
  };
  const chip: Record<string, string> = {
    fg: "bg-panel2 text-faint",
    brand: "bg-brandSoft text-brand",
    amber: "bg-amberSoft text-amber",
    go: "bg-goSoft text-go",
    sky: "bg-skySoft text-sky",
    violet: "bg-violetSoft text-violet",
    rose: "bg-roseSoft text-rose",
  };
  return (
    <div className="flex items-center gap-3 px-5 py-4">
      {icon && <div className={`grid h-9 w-9 place-items-center rounded-xl ${chip[tone]}`}>{icon}</div>}
      <div>
        <div className="eyebrow">{label}</div>
        <div className={`mt-0.5 font-mono text-[22px] font-700 leading-none tnum ${colors[tone]}`}>{value}</div>
      </div>
    </div>
  );
}

export function Chip({
  children,
  color = "muted",
  dot,
  pulse,
  solid,
}: {
  children: ReactNode;
  color?: "muted" | "brand" | "amber" | "go" | "rose" | "sky" | "violet";
  dot?: boolean;
  pulse?: boolean;
  solid?: boolean;
}) {
  const soft: Record<string, string> = {
    muted: "text-muted bg-panel2 border-line",
    brand: "text-brand bg-brandSoft border-brand/15",
    amber: "text-amber bg-amberSoft border-amber/20",
    go: "text-go bg-goSoft border-go/20",
    rose: "text-rose bg-roseSoft border-rose/20",
    sky: "text-sky bg-skySoft border-sky/20",
    violet: "text-violet bg-violetSoft border-violet/20",
  };
  const dotColor: Record<string, string> = {
    muted: "bg-faint",
    brand: "bg-brand",
    amber: "bg-amber",
    go: "bg-go",
    rose: "bg-rose",
    sky: "bg-sky",
    violet: "bg-violet",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-0.5 font-mono text-[10px] font-600 uppercase tracking-[0.08em] ${soft[color]}`}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${dotColor[color]} ${pulse ? "animate-pulse-dot" : ""}`} />}
      {children}
    </span>
  );
}

export function Empty({ icon, title, hint }: { icon: ReactNode; title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 px-6 py-16 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-panel2 text-faint">{icon}</div>
      <div className="font-display text-[14px] font-700 text-fg">{title}</div>
      <div className="max-w-[300px] text-[13px] leading-relaxed text-muted">{hint}</div>
    </div>
  );
}
