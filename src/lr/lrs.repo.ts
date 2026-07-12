import pg from "pg";

export type Lr = {
  id: string;
  lrNumber: string;
  loadId: string | null;
  ownerId: string | null;
  status: "UNPAID" | "PAID";
  paidAt: string | null;
  source: "system" | "driver_upload";
  needsReview: boolean;
  note: string | null;
  createdAt: string;
};

function rowToLr(r: any): Lr {
  return {
    id: r.id,
    lrNumber: r.lr_number,
    loadId: r.load_id,
    ownerId: r.owner_id,
    status: r.status,
    paidAt: r.paid_at ? r.paid_at.toISOString() : null,
    source: r.source,
    needsReview: r.needs_review,
    note: r.note,
    createdAt: r.created_at.toISOString(),
  };
}

export class LrsRepo {
  constructor(private pool: pg.Pool) {}

  // throws pg 23505 on duplicate lr_number — callers handle retry/reject
  async create(i: {
    lrNumber: string;
    loadId?: string | null;
    ownerId?: string | null;
    source?: "system" | "driver_upload";
    needsReview?: boolean;
  }): Promise<Lr> {
    const { rows } = await this.pool.query(
      `INSERT INTO lrs(lr_number, load_id, owner_id, source, needs_review)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [i.lrNumber, i.loadId ?? null, i.ownerId ?? null, i.source ?? "system", i.needsReview ?? false],
    );
    return rowToLr(rows[0]);
  }

  async getByNumber(lrNumber: string): Promise<Lr | null> {
    const { rows } = await this.pool.query(`SELECT * FROM lrs WHERE lr_number=$1`, [lrNumber]);
    return rows[0] ? rowToLr(rows[0]) : null;
  }

  async getByLoad(loadId: string): Promise<Lr | null> {
    const { rows } = await this.pool.query(`SELECT * FROM lrs WHERE load_id=$1`, [loadId]);
    return rows[0] ? rowToLr(rows[0]) : null;
  }

  async listByOwner(ownerId: string): Promise<Lr[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM lrs WHERE owner_id=$1 ORDER BY created_at`,
      [ownerId],
    );
    return rows.map(rowToLr);
  }

  async listNeedsReview(): Promise<Lr[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM lrs WHERE needs_review = true ORDER BY created_at`,
    );
    return rows.map(rowToLr);
  }

  async getById(id: string): Promise<Lr | null> {
    const { rows } = await this.pool.query(`SELECT * FROM lrs WHERE id=$1`, [id]);
    return rows[0] ? rowToLr(rows[0]) : null;
  }

  // Idempotent: the status='UNPAID' guard makes a second call a no-op (null),
  // so double webhooks can't double-mark payment.
  async markPaid(id: string): Promise<Lr | null> {
    const { rows } = await this.pool.query(
      `UPDATE lrs SET status='PAID', paid_at=now() WHERE id=$1 AND status='UNPAID' RETURNING *`,
      [id],
    );
    return rows[0] ? rowToLr(rows[0]) : null;
  }

  async mapOwner(id: string, ownerId: string): Promise<void> {
    await this.pool.query(`UPDATE lrs SET owner_id=$2 WHERE id=$1`, [id, ownerId]);
  }

  async appendNote(id: string, note: string): Promise<void> {
    await this.pool.query(
      `UPDATE lrs SET note = CASE WHEN note IS NULL THEN $2 ELSE note || '; ' || $2 END WHERE id=$1`,
      [id, note],
    );
  }

  async setNeedsReview(id: string, needsReview = true): Promise<void> {
    await this.pool.query(`UPDATE lrs SET needs_review=$2 WHERE id=$1`, [id, needsReview]);
  }

  // Rate-limits driver uploads: foreign LRs minted by this owner today.
  async countCreatedToday(ownerId: string): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n FROM lrs
       WHERE owner_id=$1 AND source='driver_upload' AND created_at >= now()::date`,
      [ownerId],
    );
    return rows[0].n;
  }
}
