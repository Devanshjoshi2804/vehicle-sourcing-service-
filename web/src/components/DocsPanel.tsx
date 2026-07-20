import { useState } from "react";
import { api, DriverDoc, Lr } from "../api/client";
import { inr } from "../lib/format";
import { Button, Chip, Panel } from "./ui";

const kindIcon = (kind: DriverDoc["kind"]) => (kind === "invoice" ? "🧾" : "📄");

// LR + driver-submitted docs (invoices/photos) for the selected load — paired
// with The Lane/The Line under the docket. Only rendered when there's an LR
// or at least one doc; otherwise there's nothing to review yet.
export function DocsPanel({
  lr,
  docs,
  onChange,
}: {
  lr: Lr | null;
  docs: DriverDoc[];
  onChange: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function markPaid() {
    if (!lr) return;
    setBusy(lr.id);
    setErr(null);
    try {
      await api.markLrPaid(lr.id);
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not mark paid");
    } finally {
      setBusy(null);
    }
  }

  async function resolve(docId: string) {
    setBusy(docId);
    setErr(null);
    try {
      await api.resolveDispute(docId);
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not resolve dispute");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel title="LR & docs" className="self-start">
      <div className="divide-y divide-line">
        {lr && (
          <div className="flex items-center justify-between gap-3 px-5 py-3">
            <div className="min-w-0">
              <div className="font-mono text-[13px] font-700 tnum text-fg">{lr.lrNumber}</div>
              <div className="mt-0.5 font-mono text-[11px] text-faint">
                {lr.status === "PAID" ? `paid on ${lr.paidAt?.slice(0, 10)}` : "awaiting payment"}
              </div>
            </div>
            {lr.status === "PAID" ? (
              <Chip color="go" dot>
                paid
              </Chip>
            ) : (
              <Button variant="go" onClick={markPaid} disabled={busy === lr.id} className="!py-1.5 !text-[12px]">
                {busy === lr.id ? "Marking…" : "Mark paid"}
              </Button>
            )}
          </div>
        )}

        {docs.map((d) => (
          <div key={d.id} className="flex items-center justify-between gap-3 px-5 py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="text-[15px]">{kindIcon(d.kind)}</span>
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[13px] font-600 capitalize text-fg">
                  {d.kind}
                  {d.billedInr != null && <span className="font-mono text-[12px] tnum text-muted">{inr(d.billedInr)}</span>}
                </div>
                {d.mediaUrl.startsWith("http") && (
                  <a
                    href={d.mediaUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[11px] text-brand hover:underline"
                  >
                    view
                  </a>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {d.dispute === "DISPUTED" && (
                <>
                  <Chip color="amber" dot>
                    disputed
                  </Chip>
                  <Button
                    variant="amber"
                    onClick={() => resolve(d.id)}
                    disabled={busy === d.id}
                    className="!py-1.5 !text-[11px]"
                  >
                    {busy === d.id ? "…" : "Resolve"}
                  </Button>
                </>
              )}
              {d.dispute === "RESOLVED" && (
                <Chip color="go" dot>
                  resolved
                </Chip>
              )}
            </div>
          </div>
        ))}
      </div>

      {err && <div className="border-t border-line px-5 py-2 font-mono text-[11px] text-rose">{err}</div>}
    </Panel>
  );
}
