import { useState } from "react";
import { Truck, Plus, MapPin, Circle } from "lucide-react";
import { api, OwnerInput } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { phoneShort } from "../lib/format";
import { Button, Chip, Empty, Eyebrow, Field, Panel } from "../components/ui";

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
  const [form, setForm] = useState({ name: "", phone: "+91", vehicles: "16ft", lanes: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    setErr(null);
    try {
      const input: OwnerInput = {
        name: form.name.trim(),
        phone: form.phone.trim(),
        vehicleTypes: form.vehicles.split(",").map((v) => v.trim()).filter(Boolean),
        lanes: parseLanes(form.lanes),
      };
      await api.createOwner(input);
      setForm({ name: "", phone: "+91", vehicles: "16ft", lanes: "" });
      setOpen(false);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not add driver");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1100px]">
      <div className="mb-4 flex items-center justify-between">
        <Eyebrow>{owners?.length ?? 0} drivers on the roster</Eyebrow>
        <Button variant="amber" onClick={() => setOpen((v) => !v)}>
          <Plus size={14} /> Add driver
        </Button>
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
            <Button variant="amber" onClick={add} disabled={busy || !form.name || form.phone.length < 8}>
              {busy ? "Saving…" : "Save driver"}
            </Button>
            {err && <span className="font-mono text-[11px] text-rose">{err}</span>}
          </div>
        </Panel>
      )}

      <Panel>
        {!owners || owners.length === 0 ? (
          <Empty icon={<Truck size={28} />} title="No drivers yet" hint="Add your vehicle owners — their lanes and vehicle types drive the auto-matcher." />
        ) : (
          <div className="divide-y divide-line/70">
            <div className="grid grid-cols-[1.4fr_1fr_1fr_1.4fr_auto] gap-3 px-4 py-2.5 eyebrow">
              <span>Driver</span>
              <span>Phone</span>
              <span>Vehicles</span>
              <span>Lanes</span>
              <span>Status</span>
            </div>
            {owners.map((o) => (
              <div key={o.id} className="grid grid-cols-[1.4fr_1fr_1fr_1.4fr_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-panel2/40">
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
                <span>
                  {o.active ? (
                    <Chip color="go" dot>Active</Chip>
                  ) : (
                    <Chip color="muted"><Circle size={9} /> Off</Chip>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
