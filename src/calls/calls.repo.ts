import pg from "pg";

export type CallFlow = "offer" | "fixed_price_followup";
export type CallStatus = "QUEUED" | "DIALING" | "IN_PROGRESS" | "DONE" | "NO_ANSWER" | "FAILED";
export type NewCallAttempt = {
  loadId: string;
  ownerId: string;
  phone: string;
  flow: CallFlow;
  attemptNo?: number;
};
export type CallAttempt = {
  id: string;
  loadId: string;
  ownerId: string;
  phone: string;
  flow: CallFlow;
  status: CallStatus;
  elConversationId: string | null;
  attemptNo: number;
  createdAt: string;
  endedAt: string | null;
};

function rowToCall(r: any): CallAttempt {
  return {
    id: r.id,
    loadId: r.load_id,
    ownerId: r.owner_id,
    phone: r.phone,
    flow: r.flow,
    status: r.status,
    elConversationId: r.el_conversation_id,
    attemptNo: r.attempt_no,
    createdAt: r.created_at.toISOString(),
    endedAt: r.ended_at ? r.ended_at.toISOString() : null,
  };
}

export class CallsRepo {
  constructor(private pool: pg.Pool) {}

  async create(a: NewCallAttempt): Promise<CallAttempt> {
    const { rows } = await this.pool.query(
      `INSERT INTO call_attempts(load_id,owner_id,phone,flow,attempt_no,status)
       VALUES ($1,$2,$3,$4,$5,'QUEUED') RETURNING *`,
      [a.loadId, a.ownerId, a.phone, a.flow, a.attemptNo ?? 1],
    );
    return rowToCall(rows[0]);
  }

  async setStatus(id: string, status: CallStatus, opts: { ended?: boolean } = {}): Promise<void> {
    await this.pool.query(
      `UPDATE call_attempts SET status=$2, ended_at=CASE WHEN $3 THEN now() ELSE ended_at END WHERE id=$1`,
      [id, status, opts.ended ?? false],
    );
  }

  async setConversationId(id: string, conversationId: string): Promise<void> {
    await this.pool.query(`UPDATE call_attempts SET el_conversation_id=$2 WHERE id=$1`, [
      id,
      conversationId,
    ]);
  }

  async getById(id: string): Promise<CallAttempt | null> {
    const { rows } = await this.pool.query(`SELECT * FROM call_attempts WHERE id=$1`, [id]);
    return rows[0] ? rowToCall(rows[0]) : null;
  }

  async findByConversationId(cid: string): Promise<CallAttempt | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM call_attempts WHERE el_conversation_id=$1`,
      [cid],
    );
    return rows[0] ? rowToCall(rows[0]) : null;
  }

  async listByLoad(loadId: string): Promise<CallAttempt[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM call_attempts WHERE load_id=$1 ORDER BY created_at`,
      [loadId],
    );
    return rows.map(rowToCall);
  }
}
