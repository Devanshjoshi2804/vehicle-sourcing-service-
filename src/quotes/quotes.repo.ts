import pg from "pg";

export type Availability = "YES" | "NO" | "CALLBACK";
export type QuoteInput = {
  loadId: string;
  ownerId: string;
  callAttemptId: string | null;
  elConversationId: string;
  available: Availability;
  quotedPriceInr?: number | null;
  acceptsFixed?: boolean | null;
  vehicleType?: string | null;
  note?: string | null;
};
export type Quote = {
  id: string;
  loadId: string;
  ownerId: string;
  callAttemptId: string | null;
  elConversationId: string | null;
  available: Availability;
  quotedPriceInr: number | null;
  acceptsFixed: boolean | null;
  vehicleType: string | null;
  note: string | null;
  transcript: string | null;
  createdAt: string;
};

function rowToQuote(r: any): Quote {
  return {
    id: r.id,
    loadId: r.load_id,
    ownerId: r.owner_id,
    callAttemptId: r.call_attempt_id,
    elConversationId: r.el_conversation_id,
    available: r.available,
    quotedPriceInr: r.quoted_price_inr,
    acceptsFixed: r.accepts_fixed,
    vehicleType: r.vehicle_type,
    note: r.note,
    transcript: r.transcript,
    createdAt: r.created_at.toISOString(),
  };
}

export class QuotesRepo {
  constructor(private pool: pg.Pool) {}

  async upsertByConversation(q: QuoteInput): Promise<{ created: boolean }> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO quotes(load_id,owner_id,call_attempt_id,el_conversation_id,available,quoted_price_inr,accepts_fixed,vehicle_type,note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (el_conversation_id) WHERE el_conversation_id IS NOT NULL DO NOTHING`,
      [
        q.loadId,
        q.ownerId,
        q.callAttemptId,
        q.elConversationId,
        q.available,
        q.quotedPriceInr ?? null,
        q.acceptsFixed ?? null,
        q.vehicleType ?? null,
        q.note ?? null,
      ],
    );
    return { created: (rowCount ?? 0) > 0 };
  }

  async attachTranscript(conversationId: string, transcript: string): Promise<void> {
    await this.pool.query(`UPDATE quotes SET transcript=$2 WHERE el_conversation_id=$1`, [
      conversationId,
      transcript,
    ]);
  }

  async listByLoad(
    loadId: string,
    filter?: { available?: Availability; acceptsFixed?: boolean },
  ): Promise<Quote[]> {
    const clauses = ["load_id=$1"];
    const params: any[] = [loadId];
    if (filter?.available) {
      params.push(filter.available);
      clauses.push(`available=$${params.length}`);
    }
    if (filter?.acceptsFixed !== undefined) {
      params.push(filter.acceptsFixed);
      clauses.push(`accepts_fixed=$${params.length}`);
    }
    const { rows } = await this.pool.query(
      `SELECT * FROM quotes WHERE ${clauses.join(" AND ")}
       ORDER BY (available='YES' AND accepts_fixed=true) DESC, created_at ASC`,
      params,
    );
    return rows.map(rowToQuote);
  }
}
