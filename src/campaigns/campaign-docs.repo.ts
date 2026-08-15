import pg from "pg";

export type DocSource = "wa" | "link";
export type DocStatus = "received" | "verified" | "rejected";

export type CampaignDoc = {
  id: string;
  contactId: string;
  source: DocSource;
  mediaUrl: string | null;
  filePath: string | null;
  extracted: Record<string, unknown>;
  status: DocStatus;
  createdAt: string;
};

export type CampaignEvent = {
  id: string;
  contactId: string;
  leg: number | null;
  kind: string;
  detail: Record<string, unknown>;
  at: string;
};

function rowToDoc(r: any): CampaignDoc {
  return {
    id: r.id,
    contactId: r.contact_id,
    source: r.source,
    mediaUrl: r.media_url,
    filePath: r.file_path,
    extracted: r.extracted,
    status: r.status,
    createdAt: r.created_at.toISOString(),
  };
}

function rowToEvent(r: any): CampaignEvent {
  return {
    id: r.id,
    contactId: r.contact_id,
    leg: r.leg,
    kind: r.kind,
    detail: r.detail,
    at: r.at.toISOString(),
  };
}

export class CampaignDocsRepo {
  constructor(private pool: pg.Pool) {}

  async create(d: {
    contactId: string;
    source: DocSource;
    mediaUrl?: string | null;
    filePath?: string | null;
    extracted?: Record<string, unknown>;
  }): Promise<CampaignDoc> {
    const { rows } = await this.pool.query(
      `INSERT INTO campaign_docs(contact_id,source,media_url,file_path,extracted)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [d.contactId, d.source, d.mediaUrl ?? null, d.filePath ?? null, d.extracted ?? {}],
    );
    return rowToDoc(rows[0]);
  }

  async get(id: string): Promise<CampaignDoc | null> {
    const { rows } = await this.pool.query(`SELECT * FROM campaign_docs WHERE id=$1`, [id]);
    return rows[0] ? rowToDoc(rows[0]) : null;
  }

  async setStatus(id: string, status: DocStatus): Promise<void> {
    await this.pool.query(`UPDATE campaign_docs SET status=$2 WHERE id=$1`, [id, status]);
  }

  async listByContact(contactId: string): Promise<CampaignDoc[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM campaign_docs WHERE contact_id=$1 ORDER BY created_at`,
      [contactId],
    );
    return rows.map(rowToDoc);
  }

  async countByCampaign(campaignId: string): Promise<{ received: number; verified: number }> {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS received,
              count(*) FILTER (WHERE d.status='verified')::int AS verified
         FROM campaign_docs d
         JOIN campaign_contacts c ON c.id = d.contact_id
        WHERE c.campaign_id=$1`,
      [campaignId],
    );
    return { received: rows[0].received, verified: rows[0].verified };
  }
}

export class CampaignEventsRepo {
  constructor(private pool: pg.Pool) {}

  // Best-effort audit trail: a failed event write must never break a leg.
  async log(
    contactId: string,
    kind: string,
    opts: { leg?: number | null; detail?: Record<string, unknown> } = {},
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO campaign_events(contact_id,leg,kind,detail) VALUES ($1,$2,$3,$4)`,
        [contactId, opts.leg ?? null, kind, opts.detail ?? {}],
      );
    } catch {
      /* timeline is observability, not state */
    }
  }

  async listByContact(contactId: string): Promise<CampaignEvent[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM campaign_events WHERE contact_id=$1 ORDER BY at`,
      [contactId],
    );
    return rows.map(rowToEvent);
  }
}
