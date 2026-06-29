import pg from "pg";
import { ResolvedLocation } from "../geo/geo.js";

export type DemandStatus = "NEW" | "REJECTED" | "APPROVED" | "SOURCING" | "CONFIRMED";

export type DemandInput = {
  customerPhone: string;
  fromText: string;
  toText: string;
  fromResolved?: ResolvedLocation | null;
  toResolved?: ResolvedLocation | null;
  vehicleType?: string | null;
  offeredPriceInr?: number | null;
  pickupDate?: string | null;
  elConversationId: string;
  note?: string | null;
};

export type DemandRequest = {
  id: string;
  customerPhone: string;
  fromText: string;
  toText: string;
  fromResolved: ResolvedLocation | null;
  toResolved: ResolvedLocation | null;
  vehicleType: string | null;
  offeredPriceInr: number | null;
  pickupDate: string | null;
  status: DemandStatus;
  loadId: string | null;
  elConversationId: string | null;
  transcript: string | null;
  note: string | null;
  createdAt: string;
};

function rowToDemand(r: any): DemandRequest {
  return {
    id: r.id,
    customerPhone: r.customer_phone,
    fromText: r.from_text,
    toText: r.to_text,
    fromResolved: r.from_resolved,
    toResolved: r.to_resolved,
    vehicleType: r.vehicle_type,
    offeredPriceInr: r.offered_price_inr,
    pickupDate:
      r.pickup_date instanceof Date ? r.pickup_date.toISOString().slice(0, 10) : r.pickup_date,
    status: r.status,
    loadId: r.load_id,
    elConversationId: r.el_conversation_id,
    transcript: r.transcript,
    note: r.note,
    createdAt: r.created_at.toISOString(),
  };
}

export class DemandRepo {
  constructor(private pool: pg.Pool) {}

  // Idempotent on el_conversation_id so a duplicate inbound webhook is a no-op.
  async upsertByConversation(i: DemandInput): Promise<{ created: boolean; demand: DemandRequest }> {
    const inserted = await this.pool.query(
      `INSERT INTO demand_requests
         (customer_phone, from_text, to_text, from_resolved, to_resolved, vehicle_type,
          offered_price_inr, pickup_date, el_conversation_id, note)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10)
       ON CONFLICT (el_conversation_id) WHERE el_conversation_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        i.customerPhone,
        i.fromText,
        i.toText,
        i.fromResolved ? JSON.stringify(i.fromResolved) : null,
        i.toResolved ? JSON.stringify(i.toResolved) : null,
        i.vehicleType ?? null,
        i.offeredPriceInr ?? null,
        i.pickupDate ?? null,
        i.elConversationId,
        i.note ?? null,
      ],
    );
    if (inserted.rows[0]) return { created: true, demand: rowToDemand(inserted.rows[0]) };
    const existing = await this.pool.query(
      `SELECT * FROM demand_requests WHERE el_conversation_id=$1`,
      [i.elConversationId],
    );
    return { created: false, demand: rowToDemand(existing.rows[0]) };
  }

  async getById(id: string): Promise<DemandRequest | null> {
    const { rows } = await this.pool.query(`SELECT * FROM demand_requests WHERE id=$1`, [id]);
    return rows[0] ? rowToDemand(rows[0]) : null;
  }

  async findByLoadId(loadId: string): Promise<DemandRequest | null> {
    const { rows } = await this.pool.query(`SELECT * FROM demand_requests WHERE load_id=$1`, [
      loadId,
    ]);
    return rows[0] ? rowToDemand(rows[0]) : null;
  }

  async list(filter?: { status?: DemandStatus }): Promise<DemandRequest[]> {
    if (filter?.status) {
      const { rows } = await this.pool.query(
        `SELECT * FROM demand_requests WHERE status=$1 ORDER BY created_at DESC`,
        [filter.status],
      );
      return rows.map(rowToDemand);
    }
    const { rows } = await this.pool.query(
      `SELECT * FROM demand_requests ORDER BY created_at DESC`,
    );
    return rows.map(rowToDemand);
  }

  async setStatus(id: string, status: DemandStatus): Promise<void> {
    await this.pool.query(`UPDATE demand_requests SET status=$2 WHERE id=$1`, [id, status]);
  }

  async attachLoad(id: string, loadId: string): Promise<void> {
    await this.pool.query(`UPDATE demand_requests SET load_id=$2 WHERE id=$1`, [id, loadId]);
  }
}
