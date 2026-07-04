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
    channel: r.channel,
  };
}

export class OwnersRepo {
  constructor(private pool: pg.Pool) {}

  async createOwner(i: OwnerInput): Promise<Owner> {
    const { rows } = await this.pool.query(
      `INSERT INTO owners(name, phone, vehicle_types, lanes, channel)
       VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING *`,
      [i.name, i.phone, i.vehicleTypes, JSON.stringify(i.lanes), i.channel ?? "voice"],
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
         phone = COALESCE($3, phone),
         vehicle_types = COALESCE($4, vehicle_types),
         lanes = COALESCE($5::jsonb, lanes),
         active = COALESCE($6, active),
         channel = COALESCE($7, channel)
       WHERE id = $1 RETURNING *`,
      [
        id,
        patch.name ?? null,
        patch.phone ?? null,
        patch.vehicleTypes ?? null,
        patch.lanes ? JSON.stringify(patch.lanes) : null,
        patch.active ?? null,
        patch.channel ?? null,
      ],
    );
    return rows[0] ? rowToOwner(rows[0]) : null;
  }

  // WA webhooks identify senders by bare digits ('919888888888'); owner phones
  // are stored with '+'. Match on the digit form.
  async findByPhoneDigits(digits: string): Promise<Owner | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM owners WHERE regexp_replace(phone, '\\D', '', 'g') = $1 AND active = true LIMIT 1`,
      [digits],
    );
    return rows[0] ? rowToOwner(rows[0]) : null;
  }

  // Hard delete. Drivers with call/quote history are protected by FK constraints —
  // callers should deactivate those instead ("referenced" result).
  async deleteOwner(id: string): Promise<"deleted" | "referenced" | "missing"> {
    try {
      const { rowCount } = await this.pool.query(`DELETE FROM owners WHERE id=$1`, [id]);
      return (rowCount ?? 0) > 0 ? "deleted" : "missing";
    } catch (e: any) {
      if (e?.code === "23503") return "referenced"; // pg foreign_key_violation
      throw e;
    }
  }
}
