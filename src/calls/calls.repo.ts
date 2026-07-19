import pg from "pg";

export type CallFlow = "offer" | "fixed_price_followup";
// SUPERSEDED: a different driver locked the load first, so this call no longer
// matters — we stop dialing and mark it so the board doesn't show it "on call".
export type CallStatus =
  | "QUEUED"
  | "DIALING"
  | "IN_PROGRESS"
  | "DONE"
  | "NO_ANSWER"
  | "FAILED"
  | "SUPERSEDED";
const LIVE_STATUSES = ["QUEUED", "DIALING", "IN_PROGRESS"] as const;
export type CallChannel = "voice" | "wa" | "email";
export type NewCallAttempt = {
  loadId: string;
  ownerId: string;
  phone: string;
  flow: CallFlow;
  attemptNo?: number;
  channel?: CallChannel;
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
  channel: CallChannel;
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
    channel: r.channel,
  };
}

export class CallsRepo {
  constructor(private pool: pg.Pool) {}

  async create(a: NewCallAttempt): Promise<CallAttempt> {
    const { rows } = await this.pool.query(
      `INSERT INTO call_attempts(load_id,owner_id,phone,flow,attempt_no,status,channel)
       VALUES ($1,$2,$3,$4,$5,'QUEUED',$6) RETURNING *`,
      [a.loadId, a.ownerId, a.phone, a.flow, a.attemptNo ?? 1, a.channel ?? "voice"],
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

  async setChannel(id: string, channel: CallChannel): Promise<void> {
    await this.pool.query(`UPDATE call_attempts SET channel=$2 WHERE id=$1`, [id, channel]);
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

  // The driver's newest live WhatsApp offer — lets typed replies ("haan", "15000")
  // act on the right attempt even when the tap/session context is gone.
  async findLiveWaByPhone(digits: string): Promise<CallAttempt | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM call_attempts
       WHERE regexp_replace(phone, '\\D', '', 'g') = $1 AND channel='wa' AND status = ANY($2)
       ORDER BY created_at DESC LIMIT 1`,
      [digits, LIVE_STATUSES],
    );
    return rows[0] ? rowToCall(rows[0]) : null;
  }

  // First-accept-wins: once one driver locks the load, stop dialing everyone else
  // on it. Marks every other live call SUPERSEDED and returns how many.
  async supersedePending(loadId: string, exceptOwnerId: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE call_attempts SET status='SUPERSEDED', ended_at=now()
       WHERE load_id=$1 AND owner_id<>$2 AND status = ANY($3)`,
      [loadId, exceptOwnerId, LIVE_STATUSES],
    );
    return rowCount ?? 0;
  }

  // Watchdog: a call that's been ringing / in-progress past the timeout never got
  // a terminal webhook (caller hung up, agent died). Close it so the board stops
  // showing it permanently "on call". Returns the ids that were expired.
  async expireStale(olderThanMs: number, channel: CallChannel = "voice"): Promise<string[]> {
    const { rows } = await this.pool.query(
      `UPDATE call_attempts SET status='NO_ANSWER', ended_at=now()
       WHERE status = ANY($1) AND channel = $3
         AND created_at < now() - ($2::numeric * interval '1 millisecond')
       RETURNING id`,
      [["DIALING", "IN_PROGRESS"], olderThanMs, channel],
    );
    return rows.map((r) => r.id);
  }

  // new: WA drivers still waiting on a load when someone else locks it — we tell
  // them the load is filled. Query BEFORE supersedePending flips their status.
  async listLivePeersByLoad(loadId: string, exceptOwnerId: string): Promise<CallAttempt[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM call_attempts WHERE load_id=$1 AND owner_id<>$2 AND status = ANY($3)`,
      [loadId, exceptOwnerId, LIVE_STATUSES],
    );
    return rows.map(rowToCall);
  }
}
