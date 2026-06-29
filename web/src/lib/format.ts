export const inr = (n: number | null | undefined) =>
  n == null ? "—" : "₹" + n.toLocaleString("en-IN");

export const phoneShort = (p: string) => p.replace(/^\+91/, "");

export function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function place(text: string, resolved?: { city?: string | null; canonical?: string | null } | null) {
  if (resolved?.city) return resolved.city;
  if (resolved?.canonical) return resolved.canonical.split(",")[0];
  return text;
}
