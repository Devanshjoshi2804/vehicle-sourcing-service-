import pg from "pg";
import { Owner, OwnerInput } from "./owners.schema.js";

function rowToOwner(r: any): Owner {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    vehicleTypes: r.vehicle_types,
    lanes: r.lanes,
    active: r.active,
    createdAt: r.created_at.toISOString(),
  };
}

export class OwnersRepo {
  constructor(private pool: pg.Pool) {}

  async createOwner(i: OwnerInput): Promise<Owner> {
    const { rows } = await this.pool.query(
      `INSERT INTO owners(name, phone, vehicle_types, lanes)
       VALUES ($1,$2,$3,$4::jsonb) RETURNING *`,
      [i.name, i.phone, i.vehicleTypes, JSON.stringify(i.lanes)],
    );
    return rowToOwner(rows[0]);
  }

  async listOwners(): Promise<Owner[]> {
    const { rows } = await this.pool.query(`SELECT * FROM owners ORDER BY created_at DESC`);
    return rows.map(rowToOwner);
  }

  async getActiveOwners(): Promise<Owner[]> {
    const { rows } = await this.pool.query(`SELECT * FROM owners WHERE active = true`);
    return rows.map(rowToOwner);
  }

  async updateOwner(
    id: string,
    patch: Partial<OwnerInput> & { active?: boolean },
  ): Promise<Owner | null> {
    const { rows } = await this.pool.query(
      `UPDATE owners SET
         name = COALESCE($2, name),
         vehicle_types = COALESCE($3, vehicle_types),
         lanes = COALESCE($4::jsonb, lanes),
         active = COALESCE($5, active)
       WHERE id = $1 RETURNING *`,
      [
        id,
        patch.name ?? null,
        patch.vehicleTypes ?? null,
        patch.lanes ? JSON.stringify(patch.lanes) : null,
        patch.active ?? null,
      ],
    );
    return rows[0] ? rowToOwner(rows[0]) : null;
  }
}
