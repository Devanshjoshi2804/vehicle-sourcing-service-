import pg from "pg";
import { ResolvedLocation } from "../geo/geo.js";

// The domino lifecycle of a customer demand:
//   NEW            captured but incomplete — needs a human to source manually
//   SOURCING       drivers are being auto-called with the fixed price
//   DRIVER_LOCKED  first driver accepted; awaiting the company's value approval
//   CUSTOMER_PENDING company approved; the customer is being confirmed
//   BOOKED         customer said yes — the trip is real
//   DECLINED       customer said no   |  CANCELLED  company killed it
//   REJECTED       dispatcher discarded the demand before sourcing
export type DemandStatus =
  | "NEW"
  | "REJECTED"
  | "SOURCING"
  | "DRIVER_LOCKED"
  | "CUSTOMER_PENDING"
  | "BOOKED"
  | "DECLINED"
  | "CANCELLED";

export type DemandChannel = "voice" | "whatsapp" | "console";

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
  channel?: DemandChannel;
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
  channel: DemandChannel;
  loadId: string | null;
  winningOwnerId: string | null;
  lockedPriceInr: number | null;
  approvedAt: string | null;
  bookedAt: string | null;
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
    channel: r.channel,
    loadId: r.load_id,
    winningOwnerId: r.winning_owner_id ?? null,
    lockedPriceInr: r.locked_price_inr ?? null,
    approvedAt: r.approved_at ? r.approved_at.toISOString() : null,
    bookedAt: r.booked_at ? r.booked_at.toISOString() : null,
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
          offered_price_inr, pickup_date, el_conversation_id, note, channel)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11)
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
        i.channel ?? "voice",
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

  async list(filter?: { status?: DemandStatus; loadId?: string }): Promise<DemandRequest[]> {
    const where: string[] = [];
    const args: any[] = [];
    if (filter?.status) {
      args.push(filter.status);
      where.push(`status=$${args.length}`);
    }
    if (filter?.loadId) {
      args.push(filter.loadId);
      where.push(`load_id=$${args.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const { rows } = await this.pool.query(
      `SELECT * FROM demand_requests ${clause} ORDER BY created_at DESC`,
      args,
    );
    return rows.map(rowToDemand);
  }

  async setStatus(id: string, status: DemandStatus): Promise<void> {
    await this.pool.query(`UPDATE demand_requests SET status=$2 WHERE id=$1`, [id, status]);
  }

  async attachLoad(id: string, loadId: string): Promise<void> {
    await this.pool.query(`UPDATE demand_requests SET load_id=$2 WHERE id=$1`, [id, loadId]);
  }

  // Dispatcher fills in missing fields when manually sourcing an incomplete demand.
  async patchDetails(
    id: string,
    p: { vehicleType?: string; offeredPriceInr?: number; pickupDate?: string },
  ): Promise<DemandRequest | null> {
    const { rows } = await this.pool.query(
      `UPDATE demand_requests SET
         vehicle_type      = COALESCE($2, vehicle_type),
         offered_price_inr = COALESCE($3, offered_price_inr),
         pickup_date       = COALESCE($4, pickup_date)
       WHERE id=$1 RETURNING *`,
      [id, p.vehicleType ?? null, p.offeredPriceInr ?? null, p.pickupDate ?? null],
    );
    return rows[0] ? rowToDemand(rows[0]) : null;
  }

  // Re-source: free the locked driver and reopen the demand for another call run.
  async reopen(id: string): Promise<DemandRequest | null> {
    const { rows } = await this.pool.query(
      `UPDATE demand_requests
         SET status='SOURCING', winning_owner_id=NULL, locked_price_inr=NULL, approved_at=NULL
       WHERE id=$1 RETURNING *`,
      [id],
    );
    return rows[0] ? rowToDemand(rows[0]) : null;
  }

  // First-accept-wins, race-safe: only the call that flips SOURCING → DRIVER_LOCKED
  // wins. A concurrent second accept matches no row and returns null. The winning
  // driver and the price they locked are recorded on the demand.
  async lockDriver(
    loadId: string,
    ownerId: string,
    price: number,
  ): Promise<DemandRequest | null> {
    const { rows } = await this.pool.query(
      `UPDATE demand_requests
         SET status='DRIVER_LOCKED', winning_owner_id=$2, locked_price_inr=$3
       WHERE load_id=$1 AND status='SOURCING'
       RETURNING *`,
      [loadId, ownerId, price],
    );
    return rows[0] ? rowToDemand(rows[0]) : null;
  }

  // Company approves the locked value → the customer-confirm step opens.
  async approveValue(id: string): Promise<DemandRequest | null> {
    const { rows } = await this.pool.query(
      `UPDATE demand_requests SET status='CUSTOMER_PENDING', approved_at=now()
       WHERE id=$1 AND status='DRIVER_LOCKED' RETURNING *`,
      [id],
    );
    return rows[0] ? rowToDemand(rows[0]) : null;
  }

  // Customer confirmed → the trip is booked.
  async book(id: string): Promise<DemandRequest | null> {
    const { rows } = await this.pool.query(
      `UPDATE demand_requests SET status='BOOKED', booked_at=now()
       WHERE id=$1 AND status='CUSTOMER_PENDING' RETURNING *`,
      [id],
    );
    return rows[0] ? rowToDemand(rows[0]) : null;
  }

  // Customer declines → the trip is declined. Race-safe: only succeeds if status is CUSTOMER_PENDING.
  async declinePending(id: string): Promise<DemandRequest | null> {
    const { rows } = await this.pool.query(
      `UPDATE demand_requests SET status='DECLINED'
       WHERE id=$1 AND status='CUSTOMER_PENDING' RETURNING *`,
      [id],
    );
    return rows[0] ? rowToDemand(rows[0]) : null;
  }
}
