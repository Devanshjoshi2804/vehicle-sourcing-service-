import { useMemo, useRef, useState } from "react";
import {
  Upload, Send, PhoneCall, Users, Download, Check, X, RefreshCw, Megaphone, FileText,
} from "lucide-react";
import { api, Campaign, CampaignContact, CampaignSummary, ContactStage, QueueRow } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { Panel, Button, Stat, Chip, Empty, inputBase } from "../components/ui";

type Tab = "journey" | "leg1" | "leg2" | "leg3";

const TABS: { id: Tab; label: string }[] = [
  { id: "journey", label: "Journey" },
  { id: "leg1", label: "Leg 1 · WhatsApp" },
  { id: "leg2", label: "Leg 2 · IVR" },
  { id: "leg3", label: "Leg 3 · Manual" },
];

// How each stage reads on the board, and which leg it belongs to.
const STAGE: Record<ContactStage, { label: string; color: "muted" | "brand" | "amber" | "go" | "rose" | "sky" }> = {
  UPLOADED: { label: "uploaded", color: "muted" },
  INVALID: { label: "invalid", color: "rose" },
  L1_SENT: { label: "sent · no reply", color: "muted" },
  L1_INTERESTED: { label: "1 · interested", color: "go" },
  L1_DECLINED: { label: "2 · declined", color: "amber" },
  L1_NO_REPLY: { label: "no reply", color: "muted" },
  DOC_RECEIVED: { label: "doc in review", color: "go" },
  DOC_VERIFIED: { label: "doc verified", color: "go" },
  L2_QUEUED: { label: "queued for IVR", color: "sky" },
  L2_INTERESTED: { label: "1 · interested", color: "go" },
  L2_DECLINED: { label: "2 · declined", color: "amber" },
  L2_NO_KEY: { label: "no key", color: "muted" },
  L3_QUEUED: { label: "in queue", color: "sky" },
  CONFIRMED: { label: "confirmed", color: "go" },
  CLOSED_LOST: { label: "closed lost", color: "rose" },
};

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);

// A row whose number could not be parsed is stored under a placeholder key
// (`invalid:<raw>:<n>`) so it stays visible and unique — show the operator what
// they actually typed, not our key.
const showPhone = (digits: string) =>
  digits.startsWith("invalid:") ? digits.split(":")[1] || "—" : `+${digits}`;

function Bar({ n, of, tone = "brand" }: { n: number; of: number; tone?: string }) {
  const colors: Record<string, string> = { brand: "bg-brand", go: "bg-go", amber: "bg-amber", muted: "bg-line2" };
  return (
    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-panel2">
      <div className={`h-full ${colors[tone] ?? colors.brand}`} style={{ width: `${pct(n, of)}%` }} />
    </div>
  );
}

function Split({ rows, total }: { rows: { label: string; n: number; tone?: string }[]; total: number }) {
  return (
    <div className="px-5 py-4">
      {rows.map((r) => (
        <div key={r.label} className="mb-3 last:mb-0">
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] text-fg">{r.label}</span>
            <span className="font-mono text-[15px] font-700 tnum text-fg">
              {r.n} <span className="text-[11px] font-500 text-faint">{pct(r.n, total)}%</span>
            </span>
          </div>
          <Bar n={r.n} of={total} tone={r.tone} />
        </div>
      ))}
      <div className="mt-3 border-t border-line pt-2 font-mono text-[12px] tnum text-muted">
        {total} = {rows.map((r) => r.n).join(" + ")}
      </div>
    </div>
  );
}

export function OutreachView() {
  const [tab, setTab] = useState<Tab>("journey");
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: campaigns, refresh: refreshCampaigns } = usePolling(() => api.listCampaigns(), 15000, []);
  const active = useMemo(
    () => (campaigns ?? []).find((c) => c.id === campaignId) ?? (campaigns ?? [])[0] ?? null,
    [campaigns, campaignId],
  );
  const { data: summary, refresh: refreshSummary } = usePolling(
    () => (active ? api.campaignSummary(active.id) : Promise.resolve(null as unknown as CampaignSummary)),
    6000,
    [active?.id],
    !!active,
  );
  const { data: contacts, refresh: refreshContacts } = usePolling(
    () => (active ? api.campaignContacts(active.id) : Promise.resolve([] as CampaignContact[])),
    6000,
    [active?.id],
    !!active,
  );
  const { data: queue, refresh: refreshQueue } = usePolling(
    () => (active ? api.manualQueue(active.id) : Promise.resolve([] as QueueRow[])),
    6000,
    [active?.id],
    !!active,
  );

  const refreshAll = () => {
    refreshSummary();
    refreshContacts();
    refreshQueue();
  };

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    try {
      setFlash(await fn());
      refreshAll();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(null);
    }
  };

  const newCampaign = async () => {
    const name = prompt("Campaign name?");
    if (!name) return;
    const c = await api.createCampaign(name);
    await refreshCampaigns();
    setCampaignId(c.id);
  };

  // The sheet is read in the browser and posted as text — .xlsx must be saved
  // as CSV first (the server parses CSV only).
  const onFile = async (file: File) => {
    if (!active) return;
    const csv = await file.text();
    await run("upload", async () => {
      const r = await api.uploadContacts(active.id, csv);
      return `${r.loaded} loaded, ${r.invalid} rejected`;
    });
  };

  if (!campaigns?.length) {
    return (
      <div className="p-6">
        <Panel title="Campaign outreach">
          <Empty
            icon={<Megaphone size={22} />}
            title="No campaigns yet"
            hint="Create one, upload a customer list, then fire the WhatsApp leg."
          />
          <div className="border-t border-line px-5 py-3">
            <Button variant="primary" onClick={newCampaign}>
              <Megaphone size={14} /> New campaign
            </Button>
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-wrap items-center gap-3">
        <select
          className="rounded-xl border border-line bg-panel px-3 py-2 text-[13px] text-fg"
          value={active?.id ?? ""}
          onChange={(e) => setCampaignId(e.target.value)}
        >
          {campaigns.map((c: Campaign) => (
            <option key={c.id} value={c.id}>
              {c.code} — {c.name}
            </option>
          ))}
        </select>
        <Button onClick={newCampaign}>New</Button>

        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
        />
        <Button onClick={() => fileRef.current?.click()} disabled={busy === "upload"}>
          <Upload size={14} /> Upload CSV
        </Button>
        <Button
          variant="primary"
          disabled={busy === "l1"}
          onClick={() => run("l1", async () => {
            const r = await api.fireLeg1(active!.id);
            return `WhatsApp sent to ${r.sent}${r.failed ? `, ${r.failed} failed` : ""}`;
          })}
        >
          <Send size={14} /> Fire WhatsApp (L1)
        </Button>
        <Button
          disabled={busy === "l2"}
          onClick={() => run("l2", async () => {
            const r = await api.dialLeg2(active!.id);
            return `${r.dialed} dialed of ${r.queued} queued`;
          })}
        >
          <PhoneCall size={14} /> Dial IVR (L2)
        </Button>
        <Button onClick={refreshAll}>
          <RefreshCw size={14} />
        </Button>
        {flash && <span className="font-mono text-[11px] text-muted">{flash}</span>}
      </header>

      <nav className="flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-[13px] transition-colors ${
              tab === t.id ? "border-b-2 border-brand font-600 text-fg" : "text-muted hover:text-fg"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "journey" && <Journey summary={summary} contacts={contacts ?? []} campaign={active} />}
      {tab === "leg1" && <Leg1 summary={summary} contacts={contacts ?? []} campaign={active} />}
      {tab === "leg2" && <Leg2 summary={summary} contacts={contacts ?? []} campaign={active} />}
      {tab === "leg3" && <Leg3 queue={queue ?? []} campaign={active} onChange={refreshAll} />}
    </div>
  );
}

function Journey({
  summary,
  contacts,
  campaign,
}: {
  summary: CampaignSummary | null;
  contacts: CampaignContact[];
  campaign: Campaign | null;
}) {
  if (!summary || !campaign) return null;
  const s = summary;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-4">
        <Panel><Stat label="WhatsApp sent" value={s.leg1.sent} tone="brand" icon={<Send size={16} />} /></Panel>
        <Panel><Stat label="Pressed 2 → leg 2" value={s.leg1.declined} tone="amber" icon={<PhoneCall size={16} />} /></Panel>
        <Panel><Stat label="IVR said 2 → leg 3" value={s.leg3.queued + s.leg3.confirmed + s.leg3.closedLost} tone="sky" icon={<Users size={16} />} /></Panel>
        <Panel><Stat label="Closed by automation" value={s.closedByAutomation} tone="go" icon={<Check size={16} />} /></Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="1 · WhatsApp" right={<Chip color="brand">{s.leg1.sent} entered</Chip>}>
          <Split
            total={s.leg1.sent}
            rows={[
              { label: "Pressed 1 — will upload", n: s.leg1.interested, tone: "go" },
              { label: "Pressed 2 — not interested", n: s.leg1.declined, tone: "amber" },
              { label: "No reply yet", n: s.leg1.noReply, tone: "muted" },
            ]}
          />
        </Panel>
        <Panel title="2 · IVR call" right={<Chip color="sky">{s.leg2.queued} entered</Chip>}>
          <Split
            total={s.leg2.queued}
            rows={[
              { label: "Said 1 — still interested", n: s.leg2.interested, tone: "go" },
              { label: "Said 2 — not interested", n: s.leg2.declined, tone: "amber" },
              { label: "No key / unanswered", n: s.leg2.queued - s.leg2.interested - s.leg2.declined, tone: "muted" },
            ]}
          />
        </Panel>
        <Panel title="3 · Manual calling" right={<Chip color="violet">{s.manualCalls} entered</Chip>}>
          <Split
            total={s.manualCalls}
            rows={[
              { label: "Confirmed by caller", n: s.leg3.confirmed, tone: "go" },
              { label: "Closed lost", n: s.leg3.closedLost, tone: "muted" },
              { label: "Still in queue", n: s.leg3.queued, tone: "brand" },
            ]}
          />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Leg reconciliation" right={<span className="font-mono text-[11px] text-faint">in = key 1 + key 2 + no answer</span>}>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left">
                {["LEG", "CHANNEL", "ENTERED", "KEY 1", "KEY 2", "NO ANSWER", "TO NEXT", ""].map((h) => (
                  <th key={h} className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-faint">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.reconciliation.map((r) => (
                <tr key={r.leg} className="border-b border-line last:border-0">
                  <td className="px-3 py-2 font-mono">{r.leg}</td>
                  <td className="px-3 py-2">{r.channel}</td>
                  <td className="px-3 py-2 font-mono tnum">{r.entered}</td>
                  <td className="px-3 py-2 font-mono tnum">{r.key1}</td>
                  <td className="px-3 py-2 font-mono tnum">{r.key2}</td>
                  <td className="px-3 py-2 font-mono tnum">{r.noAnswer}</td>
                  <td className="px-3 py-2 font-mono tnum text-muted">{r.toNextLeg || "—"}</td>
                  <td className="px-3 py-2">
                    {r.balances ? <Chip color="go">✓</Chip> : <Chip color="rose">off</Chip>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Effort saved">
          <div className="px-5 py-4">
            <div className="flex items-end gap-4">
              {[
                { n: s.totals.contacts, label: "In the campaign" },
                { n: s.leg2.queued, label: "Handled by the IVR pass" },
                { n: s.manualCalls, label: "Called by a person" },
              ].map((b) => (
                <div key={b.label} className="flex-1">
                  <div className="font-mono text-[20px] font-700 tnum text-fg">{b.n}</div>
                  <div className="text-[12px] text-muted">{b.label}</div>
                  <Bar n={b.n} of={s.totals.contacts || 1} tone="brand" />
                </div>
              ))}
            </div>
            <p className="mt-4 text-[13px] text-muted">
              {s.manualCalls === 0 && s.closedByAutomation === 0
                ? `${s.totals.contacts} numbers loaded. Fire the WhatsApp leg to start removing them from the call list.`
                : `Manual dialling is ${pct(s.manualCalls, s.totals.contacts)}% of the list — ${
                    s.closedByAutomation
                  } of ${s.totals.contacts} numbers resolved without a caller picking up the phone.`}
            </p>
          </div>
        </Panel>
      </div>

      <PeopleTable contacts={contacts} campaign={campaign} />
    </div>
  );
}

function PeopleTable({ contacts, campaign }: { contacts: CampaignContact[]; campaign: Campaign }) {
  const [filter, setFilter] = useState<"all" | "l1" | "l2" | "l3">("all");
  const inLeg2: ContactStage[] = ["L2_QUEUED", "L2_INTERESTED", "L2_DECLINED", "L2_NO_KEY", "L3_QUEUED", "CONFIRMED", "CLOSED_LOST"];
  const inLeg3: ContactStage[] = ["L3_QUEUED", "CONFIRMED", "CLOSED_LOST"];
  const rows = contacts.filter((c) =>
    filter === "all" ? true : filter === "l3" ? inLeg3.includes(c.stage) : filter === "l2" ? inLeg2.includes(c.stage) : !inLeg2.includes(c.stage),
  );

  return (
    <Panel
      title="Every person, every leg"
      right={
        <div className="flex items-center gap-1">
          {([["all", `All ${contacts.length}`], ["l1", "Leg 1 only"], ["l2", "Reached leg 2"], ["l3", "Reached leg 3"]] as const).map(
            ([id, label]) => (
              <button
                key={id}
                onClick={() => setFilter(id)}
                className={`rounded-lg px-2 py-1 text-[12px] ${filter === id ? "bg-brand text-white" : "text-muted hover:text-fg"}`}
              >
                {label}
              </button>
            ),
          )}
          <Button onClick={() => api.exportCampaign(campaign.id, campaign.code, "all")}>
            <Download size={13} /> Download
          </Button>
        </div>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-left">
              {["PERSON", "NUMBER", "CITY", "STAGE", "OWNER", "UPDATED"].map((h) => (
                <th key={h} className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-faint">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-b border-line last:border-0">
                <td className="px-3 py-2 text-fg">{c.name}</td>
                <td className="px-3 py-2 font-mono text-muted">{showPhone(c.phoneDigits)}</td>
                <td className="px-3 py-2 text-muted">{c.city ?? "—"}</td>
                <td className="px-3 py-2">
                  <Chip color={STAGE[c.stage].color}>{STAGE[c.stage].label}</Chip>
                  {c.invalidReason && <span className="ml-2 text-[11px] text-rose">{c.invalidReason}</span>}
                </td>
                <td className="px-3 py-2 text-muted">{c.ownerAgent ?? "—"}</td>
                <td className="px-3 py-2 font-mono text-[11px] text-faint">
                  {new Date(c.updatedAt).toLocaleString("en-IN", { hour12: false })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <Empty icon={<Users size={20} />} title="Nothing here yet" hint="Upload a CSV to start." />}
      </div>
    </Panel>
  );
}

function Leg1({ summary, contacts, campaign }: { summary: CampaignSummary | null; contacts: CampaignContact[]; campaign: Campaign | null }) {
  if (!summary || !campaign) return null;
  const s = summary;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-4">
        <Panel><Stat label="Sent" value={s.leg1.sent} tone="brand" icon={<Send size={16} />} /></Panel>
        <Panel><Stat label="Replied 1" value={s.leg1.interested} tone="go" /></Panel>
        <Panel><Stat label="Replied 2" value={s.leg1.declined} tone="amber" /></Panel>
        <Panel><Stat label="Documents" value={`${s.leg1.docsReceived} / ${s.leg1.docsVerified}`} tone="sky" icon={<FileText size={16} />} /></Panel>
      </div>
      <Panel
        title="Leg 1 message log"
        right={<Button onClick={() => api.exportCampaign(campaign.id, campaign.code, "1")}><Download size={13} /> CSV</Button>}
      >
        <SimpleTable
          headers={["PERSON", "NUMBER", "REPLY", "UPDATED"]}
          rows={contacts.map((c) => [
            c.name,
            showPhone(c.phoneDigits),
            <Chip key={c.id} color={STAGE[c.stage].color}>{STAGE[c.stage].label}</Chip>,
            new Date(c.updatedAt).toLocaleString("en-IN", { hour12: false }),
          ])}
        />
      </Panel>
    </div>
  );
}

function Leg2({ summary, contacts, campaign }: { summary: CampaignSummary | null; contacts: CampaignContact[]; campaign: Campaign | null }) {
  if (!summary || !campaign) return null;
  const s = summary;
  const dialed: ContactStage[] = ["L2_QUEUED", "L2_INTERESTED", "L2_DECLINED", "L2_NO_KEY", "L3_QUEUED", "CONFIRMED", "CLOSED_LOST"];
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-4">
        <Panel><Stat label="Queued" value={s.leg2.queued} tone="sky" /></Panel>
        <Panel><Stat label="Said 1" value={s.leg2.interested} tone="go" /></Panel>
        <Panel><Stat label="Said 2" value={s.leg2.declined} tone="amber" /></Panel>
        <Panel><Stat label="No key" value={s.leg2.noKey} tone="fg" /></Panel>
      </div>
      <Panel
        title="Leg 2 call log"
        right={<Button onClick={() => api.exportCampaign(campaign.id, campaign.code, "2")}><Download size={13} /> CSV</Button>}
      >
        <SimpleTable
          headers={["PERSON", "NUMBER", "OUTCOME", "UPDATED"]}
          rows={contacts
            .filter((c) => dialed.includes(c.stage))
            .map((c) => [
              c.name,
              showPhone(c.phoneDigits),
              <Chip key={c.id} color={STAGE[c.stage].color}>{STAGE[c.stage].label}</Chip>,
              new Date(c.updatedAt).toLocaleString("en-IN", { hour12: false }),
            ])}
        />
      </Panel>
    </div>
  );
}

function Leg3({ queue, campaign, onChange }: { queue: QueueRow[]; campaign: Campaign | null; onChange: () => void }) {
  const [note, setNote] = useState<Record<string, string>>({});
  if (!campaign) return null;
  const open = queue.filter((q) => q.stage === "L3_QUEUED");

  const dispose = async (id: string, outcome: "CONFIRMED" | "CLOSED_LOST") => {
    await api.disposeContact(id, outcome, note[id]);
    onChange();
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Panel><Stat label="Still in queue" value={open.length} tone="brand" icon={<Users size={16} />} /></Panel>
        <Panel><Stat label="Confirmed" value={queue.filter((q) => q.stage === "CONFIRMED").length} tone="go" /></Panel>
        <Panel><Stat label="Closed lost" value={queue.filter((q) => q.stage === "CLOSED_LOST").length} tone="rose" /></Panel>
      </div>

      <Panel
        title="Manual queue · every row with its history"
        right={<Button onClick={() => api.exportCampaign(campaign.id, campaign.code, "3")}><Download size={13} /> CSV</Button>}
      >
        {!queue.length && (
          <Empty icon={<Users size={20} />} title="Nobody needs a human yet" hint="Only double refusals land here." />
        )}
        {queue.map((q) => (
          <div key={q.id} className="border-b border-line px-5 py-4 last:border-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-600 text-fg">{q.name}</span>
              <span className="font-mono text-[12px] text-muted">{showPhone(q.phoneDigits)}</span>
              <Chip color="amber">L1: {q.leg1Result ?? "—"}</Chip>
              <Chip color="amber">L2: {q.leg2Result ?? "—"}</Chip>
              <Chip color={STAGE[q.stage].color}>{STAGE[q.stage].label}</Chip>
              <span className="font-mono text-[11px] text-faint">{q.attempts} attempts</span>
              {q.ownerAgent && <Chip color="brand">{q.ownerAgent}</Chip>}
            </div>
            {q.note && <p className="mt-1 text-[12px] text-muted">{q.note}</p>}
            {q.stage === "L3_QUEUED" && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  className={`${inputBase} max-w-sm flex-1`}
                  placeholder="Add caller note / objection…"
                  value={note[q.id] ?? ""}
                  onChange={(e) => setNote((n) => ({ ...n, [q.id]: e.target.value }))}
                />
                <Button variant="go" onClick={() => dispose(q.id, "CONFIRMED")}>
                  <Check size={13} /> Confirm (won)
                </Button>
                <Button variant="danger" onClick={() => dispose(q.id, "CLOSED_LOST")}>
                  <X size={13} /> Close lost
                </Button>
              </div>
            )}
          </div>
        ))}
      </Panel>
    </div>
  );
}

function SimpleTable({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-line text-left">
            {headers.map((h) => (
              <th key={h} className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-faint">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line last:border-0">
              {r.map((cell, j) => (
                <td key={j} className="px-3 py-2 text-fg">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="px-5 py-8 text-center text-[13px] text-muted">Nothing yet.</div>}
    </div>
  );
}
