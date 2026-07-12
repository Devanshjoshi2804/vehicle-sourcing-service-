import pg from "pg";

export type DriverDoc = {
  id: string;
  ownerId: string | null;
  phone: string;
  loadId: string | null;
  lrId: string | null;
  kind: "lr" | "invoice" | "other" | "unprocessed";
  mediaUrl: string;
  extracted: Record<string, unknown>;
  billedInr: number | null;
  varianceInr: number | null;
  dispute: "NONE" | "DISPUTED" | "RESOLVED";
  createdAt: string;
};

function rowToDoc(r: any): DriverDoc {
  return {
    id: r.id,
    ownerId: r.owner_id,
    phone: r.phone,
    loadId: r.load_id,
    lrId: r.lr_id,
    kind: r.kind,
    mediaUrl: r.media_url,
    extracted: r.extracted,
    billedInr: r.billed_inr,
    varianceInr: r.variance_inr,
    dispute: r.dispute,
    createdAt: r.created_at.toISOString(),
  };
}

export class DocsRepo {
  constructor(private pool: pg.Pool) {}

  // Re-uploads of the same doc (owner, lr, kind) update in place instead of
  // piling up rows; lr-less docs (unprocessed/unmatched) always insert.
  async upsert(i: {
    ownerId?: string | null;
    phone: string;
    loadId?: string | null;
    lrId?: string | null;
    kind: DriverDoc["kind"];
    mediaUrl: string;
    extracted?: Record<string, unknown>;
    billedInr?: number | null;
    varianceInr?: number | null;
    dispute?: DriverDoc["dispute"];
  }): Promise<DriverDoc> {
    const params = [
      i.ownerId ?? null,
      i.phone,
      i.loadId ?? null,
      i.lrId ?? null,
      i.kind,
      i.mediaUrl,
      JSON.stringify(i.extracted ?? {}),
      i.billedInr ?? null,
      i.varianceInr ?? null,
      i.dispute ?? "NONE",
    ];
    const insert = `INSERT INTO driver_docs(owner_id, phone, load_id, lr_id, kind, media_url, extracted, billed_inr, variance_inr, dispute)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`;
    const sql = i.lrId
      ? `${insert}
         ON CONFLICT (owner_id, lr_id, kind) WHERE lr_id IS NOT NULL
         DO UPDATE SET media_url=EXCLUDED.media_url, extracted=EXCLUDED.extracted,
           billed_inr=EXCLUDED.billed_inr, variance_inr=EXCLUDED.variance_inr, dispute=EXCLUDED.dispute
         RETURNING *`
      : `${insert} RETURNING *`;
    const { rows } = await this.pool.query(sql, params);
    return rowToDoc(rows[0]);
  }

  async listByLoad(loadId: string): Promise<DriverDoc[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM driver_docs WHERE load_id=$1 ORDER BY created_at`,
      [loadId],
    );
    return rows.map(rowToDoc);
  }

  async getById(id: string): Promise<DriverDoc | null> {
    const { rows } = await this.pool.query(`SELECT * FROM driver_docs WHERE id=$1`, [id]);
    return rows[0] ? rowToDoc(rows[0]) : null;
  }

  // Links a doc created as an unlinked "guess, pending confirmation" invoice
  // (load_id/lr_id null) to the trip the driver just confirmed. Updates the
  // SAME row by id — a plain upsert() would insert a second row instead, since
  // this row's lr_id is only becoming non-null now.
  // On 23505 collision (existing invoice for same owner/lr/kind), merges into
  // the existing row and deletes the pending row.
  async linkInvoice(
    id: string,
    p: { loadId: string; lrId: string | null; billedInr: number | null; varianceInr: number | null; dispute: DriverDoc["dispute"] },
  ): Promise<DriverDoc | null> {
    try {
      const { rows } = await this.pool.query(
        `UPDATE driver_docs SET load_id=$2, lr_id=$3, billed_inr=$4, variance_inr=$5, dispute=$6 WHERE id=$1 RETURNING *`,
        [id, p.loadId, p.lrId, p.billedInr, p.varianceInr, p.dispute],
      );
      return rows[0] ? rowToDoc(rows[0]) : null;
    } catch (err: any) {
      // 23505: unique constraint violation on driver_docs_owner_lr_kind.
      // A doc already exists for this (owner_id, lr_id, kind) combo.
      // ponytail: merge into existing row by fetching its id, updating it, and deleting pending.
      if (err.code !== "23505") throw err;

      // Fetch the pending doc to get owner_id and kind for the existing doc lookup.
      const pending = await this.getById(id);
      if (!pending || !p.lrId) return null;

      // Find the existing doc that conflicted (already matched invoice for this trip).
      const { rows: existing } = await this.pool.query(
        `SELECT id FROM driver_docs WHERE owner_id=$1 AND lr_id=$2 AND kind='invoice' AND lr_id IS NOT NULL`,
        [pending.ownerId, p.lrId],
      );
      if (!existing[0]) return null;

      const existingId = existing[0].id;
      // Update the existing row with the new media + dispute details from the pending doc.
      const { rows } = await this.pool.query(
        `UPDATE driver_docs SET media_url=$2, extracted=$3, billed_inr=$4, variance_inr=$5, dispute=$6 WHERE id=$1 RETURNING *`,
        [existingId, pending.mediaUrl, JSON.stringify(pending.extracted), p.billedInr, p.varianceInr, p.dispute],
      );
      // Delete the orphaned pending row.
      await this.pool.query(`DELETE FROM driver_docs WHERE id=$1`, [id]);
      return rows[0] ? rowToDoc(rows[0]) : null;
    }
  }

  // DISPUTED → RESOLVED only; anything else is a no-op (null).
  async resolveDispute(id: string): Promise<DriverDoc | null> {
    const { rows } = await this.pool.query(
      `UPDATE driver_docs SET dispute='RESOLVED' WHERE id=$1 AND dispute='DISPUTED' RETURNING *`,
      [id],
    );
    return rows[0] ? rowToDoc(rows[0]) : null;
  }
}
