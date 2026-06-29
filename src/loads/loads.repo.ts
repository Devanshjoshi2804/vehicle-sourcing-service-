import pg from "pg";
import { Load, LoadInput, LoadStatus } from "./loads.schema.js";

function rowToLoad(r: any): Load {
  return {
    id: r.id,
    fromLocation: r.from_location,
    toLocation: r.to_location,
    vehicleType: r.vehicle_type,
    pickupDate:
      r.pickup_date instanceof Date ? r.pickup_date.toISOString().slice(0, 10) : r.pickup_date,
    fixedPriceInr: r.fixed_price_inr,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
  };
}

export class LoadsRepo {
  constructor(private pool: pg.Pool) {}

  async createLoad(i: LoadInput): Promise<Load> {
    const { rows } = await this.pool.query(
      `INSERT INTO loads(from_location,to_location,vehicle_type,pickup_date,fixed_price_inr,created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [i.fromLocation, i.toLocation, i.vehicleType, i.pickupDate, i.fixedPriceInr, i.createdBy],
    );
    return rowToLoad(rows[0]);
  }

  async getLoad(id: string): Promise<Load | null> {
    const { rows } = await this.pool.query(`SELECT * FROM loads WHERE id=$1`, [id]);
    return rows[0] ? rowToLoad(rows[0]) : null;
  }

  async setStatus(id: string, status: LoadStatus): Promise<void> {
    await this.pool.query(`UPDATE loads SET status=$2 WHERE id=$1`, [id, status]);
  }
}
