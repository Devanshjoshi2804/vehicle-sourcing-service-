import pg from "pg";

export type CampaignLeg = 1 | 2 | 3;
export type CampaignChannel = "wa" | "ivr" | "manual";
export type AttemptStatus =
  | "QUEUED"
  | "DIALING"
  | "IN_PROGRESS"
  | "DONE"
  | "NO_ANSWER"
  | "FAILED"
  | "SUPERSEDED";

export type CampaignAttempt = {
  id: string;
  contactId: string;
  leg: CampaignLeg;
  channel: CampaignChannel;
  status: AttemptStatus;
  providerRef: string | null;
  attemptNo: number;
  digit: string | null;
  durationS: number | null;
  createdAt: string;
  endedAt: string | null;
};

function rowToAttempt(r: any): CampaignAttempt {
  return {
    id: r.id,
    contactId: r.contact_id,
    leg: r.leg,
    channel: r.channel,
    status: r.status,
    providerRef: r.provider_ref,
    attemptNo: r.attempt_no,
    digit: r.digit,
    durationS: r.duration_s,
    createdAt: r.created_at.toISOString(),
    endedAt: r.ended_at ? r.ended_at.toISOString() : null,
  };
}

export class CampaignAttemptsRepo {
  constructor(private pool: pg.Pool) {}

  async create(a: {
    contactId: string;
    leg: CampaignLeg;
    channel: CampaignChannel;
    attemptNo?: number;
  }): Promise<CampaignAttempt> {
    const { rows } = await this.pool.query(
      `INSERT INTO campaign_attempts(contact_id,leg,channel,attempt_no) VALUES ($1,$2,$3,$4) RETURNING *`,
      [a.contactId, a.leg, a.channel, a.attemptNo ?? 1],
    );
    return rowToAttempt(rows[0]);
  }

  async getById(id: string): Promise<CampaignAttempt | null> {
    const { rows } = await this.pool.query(`SELECT * FROM campaign_attempts WHERE id=$1`, [id]);
    return rows[0] ? rowToAttempt(rows[0]) : null;
  }

  async setStatus(id: string, status: AttemptStatus, opts: { ended?: boolean } = {}): Promise<void> {
    await this.pool.query(
      `UPDATE campaign_attempts
          SET status=$2, ended_at=CASE WHEN $3 THEN now() ELSE ended_at END
        WHERE id=$1`,
      [id, status, opts.ended ?? false],
    );
  }

  async setProviderRef(id: string, ref: string): Promise<void> {
    await this.pool.query(`UPDATE campaign_attempts SET provider_ref=$2 WHERE id=$1`, [id, ref]);
  }

  // The IVR leg's terminal write: the pressed digit plus how long the call ran.
  async recordDigit(id: string, digit: string | null, durationS?: number | null): Promise<void> {
    await this.pool.query(
      `UPDATE campaign_attempts
          SET digit=$2, duration_s=COALESCE($3, duration_s), status='DONE', ended_at=now()
        WHERE id=$1`,
      [id, digit, durationS ?? null],
    );
  }

  async listByContact(contactId: string): Promise<CampaignAttempt[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM campaign_attempts WHERE contact_id=$1 ORDER BY created_at`,
      [contactId],
    );
    return rows.map(rowToAttempt);
  }

  async listByCampaign(campaignId: string, leg?: CampaignLeg): Promise<CampaignAttempt[]> {
    const { rows } = await this.pool.query(
      `SELECT a.* FROM campaign_attempts a
         JOIN campaign_contacts c ON c.id = a.contact_id
        WHERE c.campaign_id=$1 AND ($2::smallint IS NULL OR a.leg=$2)
        ORDER BY a.created_at`,
      [campaignId, leg ?? null],
    );
    return rows.map(rowToAttempt);
  }

  // Newest live attempt on a leg for a contact — inbound replies and the IVR
  // digit webhook both need "which attempt is this about".
  async findLive(contactId: string, leg: CampaignLeg): Promise<CampaignAttempt | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM campaign_attempts
        WHERE contact_id=$1 AND leg=$2 AND status IN ('QUEUED','DIALING','IN_PROGRESS')
        ORDER BY created_at DESC LIMIT 1`,
      [contactId, leg],
    );
    return rows[0] ? rowToAttempt(rows[0]) : null;
  }

  async countByContactLeg(contactId: string, leg: CampaignLeg): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n FROM campaign_attempts WHERE contact_id=$1 AND leg=$2`,
      [contactId, leg],
    );
    return rows[0].n;
  }

  // Stale-attempt sweep, mirroring calls.repo's watchdog query.
  async closeStale(minutes: number, channel: CampaignChannel): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE campaign_attempts
          SET status='NO_ANSWER', ended_at=now()
        WHERE channel=$2
          AND status IN ('QUEUED','DIALING','IN_PROGRESS')
          AND created_at < now() - ($1 || ' minutes')::interval`,
      [String(minutes), channel],
    );
    return rowCount ?? 0;
  }
}
