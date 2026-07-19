import pg from "pg";

export type EmailSession = {
  address: string;
  role: "customer" | "driver";
  state: string;
  ctx: Record<string, unknown>;
};

const rowToSession = (r: any): EmailSession => ({
  address: r.address, role: r.role, state: r.state, ctx: r.ctx ?? {},
});

export class EmailSessionsRepo {
  constructor(private pool: pg.Pool) {}

  async get(address: string): Promise<EmailSession | null> {
    const { rows } = await this.pool.query(`SELECT * FROM email_sessions WHERE address=$1`, [address]);
    return rows[0] ? rowToSession(rows[0]) : null;
  }

  // ctx merges (jsonb ||) so flows can add draft fields incrementally.
  async upsert(s: {
    address: string; role: "customer" | "driver"; state: string;
    ctx?: Record<string, unknown>;
  }): Promise<EmailSession> {
    const { rows } = await this.pool.query(
      `INSERT INTO email_sessions(address, role, state, ctx)
       VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (address) DO UPDATE SET
         role=$2, state=$3,
         ctx = email_sessions.ctx || $4::jsonb,
         updated_at = now()
       RETURNING *`,
      [s.address, s.role, s.state, JSON.stringify(s.ctx ?? {})],
    );
    return rowToSession(rows[0]);
  }

  // "Clear" ends the active flow but KEEPS the row: processed_ids keep deduping
  // redelivered mail, and lastInbound survives so a redelivery of the message
  // that ENDED the flow is still deduped.
  async clear(address: string): Promise<void> {
    await this.pool.query(
      `UPDATE email_sessions
         SET state='IDLE',
             ctx = CASE WHEN ctx ? 'lastInbound'
                        THEN jsonb_build_object('lastInbound', ctx->'lastInbound')
                        ELSE '{}'::jsonb END,
             updated_at=now()
       WHERE address=$1`,
      [address],
    );
  }

  // Idempotency for mail redeliveries: false = already seen. Keeps last 20 ids.
  async markProcessed(address: string, messageId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE email_sessions
         SET processed_ids = (ARRAY[$2] || processed_ids)[1:20], updated_at = now()
       WHERE address=$1 AND NOT ($2 = ANY(processed_ids))`,
      [address, messageId],
    );
    return (rowCount ?? 0) > 0;
  }
}
