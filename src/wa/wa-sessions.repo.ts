import pg from "pg";
import { WaOption } from "./interakt.client.js";

export type WaSession = {
  phone: string;
  role: "customer" | "driver";
  state: string;
  ctx: Record<string, unknown>;
  lastOptions: WaOption[];
};

const rowToSession = (r: any): WaSession => ({
  phone: r.phone, role: r.role, state: r.state, ctx: r.ctx ?? {}, lastOptions: r.last_options ?? [],
});

export class WaSessionsRepo {
  constructor(private pool: pg.Pool) {}

  async get(phone: string): Promise<WaSession | null> {
    const { rows } = await this.pool.query(`SELECT * FROM wa_sessions WHERE phone=$1`, [phone]);
    return rows[0] ? rowToSession(rows[0]) : null;
  }

  // ctx merges (jsonb ||) so flows can add draft fields incrementally;
  // lastOptions replaces wholesale (it always reflects the latest send).
  async upsert(s: {
    phone: string; role: "customer" | "driver"; state: string;
    ctx?: Record<string, unknown>; lastOptions?: WaOption[];
  }): Promise<WaSession> {
    const { rows } = await this.pool.query(
      `INSERT INTO wa_sessions(phone, role, state, ctx, last_options)
       VALUES ($1,$2,$3,$4::jsonb,COALESCE($5::jsonb,'[]'::jsonb))
       ON CONFLICT (phone) DO UPDATE SET
         role=$2, state=$3,
         ctx = wa_sessions.ctx || $4::jsonb,
         last_options = COALESCE($5::jsonb, wa_sessions.last_options),
         updated_at = now()
       RETURNING *`,
      [s.phone, s.role, s.state, JSON.stringify(s.ctx ?? {}), s.lastOptions ? JSON.stringify(s.lastOptions) : null],
    );
    return rowToSession(rows[0]);
  }

  // "Clear" ends the active flow but KEEPS the row: processed_ids keep deduping
  // webhook redeliveries, last_options keep buttons on older messages resolvable
  // (the provider echoes only the tapped title), and lastInbound survives so a
  // redelivery of the action that ENDED the flow is still deduped.
  async clear(phone: string): Promise<void> {
    await this.pool.query(
      `UPDATE wa_sessions
         SET state='IDLE',
             ctx = CASE WHEN ctx ? 'lastInbound'
                        THEN jsonb_build_object('lastInbound', ctx->'lastInbound')
                        ELSE '{}'::jsonb END,
             updated_at=now()
       WHERE phone=$1`,
      [phone],
    );
  }

  // Idempotency for Interakt redeliveries: false = already seen. Keeps last 20 ids.
  async markProcessed(phone: string, msgId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE wa_sessions
         SET processed_ids = (ARRAY[$2] || processed_ids)[1:20], updated_at = now()
       WHERE phone=$1 AND NOT ($2 = ANY(processed_ids))`,
      [phone, msgId],
    );
    return (rowCount ?? 0) > 0;
  }
}
