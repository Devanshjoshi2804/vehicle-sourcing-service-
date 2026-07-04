import { useMemo, useState } from "react";
import { Truck, Plus, MapPin, Circle, Route, Radio, Pencil, Trash2 } from "lucide-react";
import { api, Owner, OwnerInput } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { phoneShort } from "../lib/format";
import { Button, Chip, Empty, Field, Panel } from "../components/ui";

function parseLanes(s: string) {
  return s
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [from, to] = p.split(/>|→|-/).map((x) => x.trim());
      return from && to ? { from, to } : null;
    })
    .filter(Boolean) as { from: string; to: string }[];
}

export function DriversView() {
  const { data: owners, refresh } = usePolling(() => api.listOwners(), 8000, []);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", phone: "+91", vehicles: "16ft", lanes: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<string | null>(null);

  function startEdit(o: Owner) {
    setEditingId(o.id);
    setForm({
      name: o.name,
      phone: o.phone,
      vehicles: o.vehicleTypes.join(", "),
      lanes: o.lanes.map((l) => `${l.from} > ${l.to}`).join(", "),
    });
    setOpen(true);
    setErr(null);
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const input: OwnerInput = {
        name: form.name.trim(),
        phone: form.phone.trim(),
        vehicleTypes: form.vehicles.split(",").map((v) => v.trim()).filter(Boolean),
        lanes: parseLanes(form.lanes),
      };
      if (editingId) await api.updateOwner(editingId, input);
      else await api.createOwner(input);
      setForm({ name: "", phone: "+91", vehicles: "16ft", lanes: "" });
      setOpen(false);
      setEditingId(null);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not save driver");
    } finally {
      setBusy(false);
    }
  }

  async function remove(o: Owner) {
    if (!window.confirm(`Delete ${o.name}? This cannot be undone.`)) return;
    setRowErr(null);
    try {
      await api.deleteOwner(o.id);
    } catch (e) {
      // 409 = has call history — keep the record, switch the driver off instead
      if (e instanceof Error && e.message.startsWith("409")) {
        await api.updateOwner(o.id, { active: false });
        setRowErr(`${o.name} has call history — deactivated instead of deleted.`);
      } else {
        setRowErr(e instanceof Error ? e.message : "could not delete driver");
      }
    }
    refresh();
  }

  const stats = useMemo(() => {
    const os = owners ?? [];
    const lanes = new Set<string>();
    const vehicles = new Set<string>();
    let active = 0;
    for (const o of os) {
      if (o.active) active++;
      o.lanes.forEach((l) => lanes.add(`${l.from}→${l.to}`));
      o.vehicleTypes.forEach((v) => vehicles.add(v));
    }
    return { total: os.length, active, lanes: lanes.size, vehicles: vehicles.size };
  }, [owners]);

  return (
    <div className="mx-auto max-w-[1100px]">
      <div className="mb-5 flex flex-wrap items-stretch gap-3">
        <RosterStat icon={<Truck size={16} />} label="Trucks" value={stats.total} tone="brand" />
        <RosterStat icon={<Radio size={16} />} label="Active now" value={stats.active} tone="go" live={stats.active > 0} />
        <RosterStat icon={<Route size={16} />} label="Lanes covered" value={stats.lanes} tone="amber" />
        <RosterStat icon={<MapPin size={16} />} label="Vehicle types" value={stats.vehicles} tone="sky" />
        <div className="ml-auto flex items-end">
          <Button
            variant="primary"
            onClick={() => {
              if (open) { setOpen(false); setEditingId(null); }
              else { setEditingId(null); setForm({ name: "", phone: "+91", vehicles: "16ft", lanes: "" }); setOpen(true); }
            }}
            className="!py-2.5"
          >
            <Plus size={14} /> Add truck
          </Button>
        </div>
      </div>

      {open && (
        <Panel className="mb-4 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ramesh Transport" />
            <Field label="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+9199…" />
            <Field label="Vehicle types" value={form.vehicles} onChange={(e) => setForm({ ...form, vehicles: e.target.value })} placeholder="16ft, 20ft" />
            <Field label="Lanes (from > to, …)" value={form.lanes} onChange={(e) => setForm({ ...form, lanes: e.target.value })} placeholder="Mumbai > Pune" />
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Button variant="primary" onClick={save} disabled={busy || !form.name || form.phone.length < 8}>
              {busy ? "Saving…" : editingId ? "Update driver" : "Save driver"}
            </Button>
            {err && <span className="font-mono text-[11px] text-rose">{err}</span>}
          </div>
        </Panel>
      )}

      {rowErr && (
        <div className="mb-3 rounded-xl border border-line bg-amberSoft/60 px-4 py-2 font-mono text-[11px] text-amber">
          {rowErr}
        </div>
      )}
      <Panel>
        {!owners || owners.length === 0 ? (
          <Empty icon={<Truck size={28} />} title="No drivers yet" hint="Add your vehicle owners — their lanes and vehicle types drive the auto-matcher." />
        ) : (
          <div className="divide-y divide-line/70">
            <div className="grid grid-cols-[1.4fr_1fr_1fr_1.4fr_auto_auto_auto] gap-3 px-4 py-2.5 eyebrow">
              <span>Driver</span>
              <span>Phone</span>
              <span>Vehicles</span>
              <span>Lanes</span>
              <span>Channel</span>
              <span>Status</span>
              <span className="text-right">Actions</span>
            </div>
            {owners.map((o) => (
              <div key={o.id} className="grid grid-cols-[1.4fr_1fr_1fr_1.4fr_auto_auto_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-panel2/40">
                <span className="truncate text-[13px] font-600 text-fg">{o.name}</span>
                <span className="font-mono text-[12px] tnum text-muted">{phoneShort(o.phone)}</span>
                <span className="flex flex-wrap gap-1">
                  {o.vehicleTypes.map((v) => (
                    <Chip key={v} color="muted">{v}</Chip>
                  ))}
                </span>
                <span className="flex min-w-0 flex-wrap gap-1.5">
                  {o.lanes.length === 0 ? (
                    <span className="text-[12px] text-faint">—</span>
                  ) : (
                    o.lanes.slice(0, 3).map((l, i) => (
                      <span key={i} className="flex items-center gap-1 font-mono text-[11px] text-muted">
                        <MapPin size={10} className="text-faint" />
                        {l.from}<span className="text-faint">→</span>{l.to}
                      </span>
                    ))
                  )}
                </span>
                <select
                  value={o.channel}
                  onChange={(e) => api.updateOwner(o.id, { channel: e.target.value as Owner["channel"] }).then(refresh)}
                  className="rounded-lg border border-line bg-panel2 px-2 py-1 font-mono text-[11px] text-fg focus:border-brand focus:bg-panel focus:outline-none focus:ring-4 focus:ring-brand/10"
                >
                  <option value="voice">📞 Voice</option>
                  <option value="whatsapp">💬 WhatsApp</option>
                  <option value="both">📞💬 Both</option>
                </select>
                <button
                  onClick={() => api.updateOwner(o.id, { active: !o.active }).then(refresh).catch(() => setRowErr("could not update status"))}
                  title={o.active ? "Click to switch off" : "Click to activate"}
                  className="cursor-pointer"
                >
                  {o.active ? (
                    <Chip color="go" dot>Active</Chip>
                  ) : (
                    <Chip color="muted"><Circle size={9} /> Off</Chip>
                  )}
                </button>
                <span className="flex items-center justify-end gap-1">
                  <button
                    onClick={() => startEdit(o)}
                    title="Edit driver"
                    className="grid h-7 w-7 place-items-center rounded-lg text-muted transition hover:bg-panel2 hover:text-fg"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    onClick={() => remove(o)}
                    title="Delete driver"
                    className="grid h-7 w-7 place-items-center rounded-lg text-muted transition hover:bg-roseSoft hover:text-rose"
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function RosterStat({
  icon,
  label,
  value,
  tone,
  live,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: "brand" | "go" | "amber" | "sky";
  live?: boolean;
}) {
  const chip: Record<string, string> = {
    brand: "bg-brandSoft text-brand",
    go: "bg-goSoft text-go",
    amber: "bg-amberSoft text-amber",
    sky: "bg-skySoft text-sky",
  };
  const num: Record<string, string> = {
    brand: "text-brand",
    go: "text-go",
    amber: "text-amber",
    sky: "text-sky",
  };
  return (
    <div className="card flex min-w-[150px] items-center gap-3 px-4 py-3">
      <span className={`relative grid h-9 w-9 place-items-center rounded-xl ${chip[tone]}`}>
        {icon}
        {live && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-go ring-2 ring-panel animate-pulse-dot" />}
      </span>
      <div>
        <div className="eyebrow">{label}</div>
        <div className={`mt-0.5 font-mono text-[22px] font-700 leading-none tnum ${num[tone]}`}>{value}</div>
      </div>
    </div>
  );
}
