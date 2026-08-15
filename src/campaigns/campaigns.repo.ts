import pg from "pg";

export type CampaignStatus = "DRAFT" | "RUNNING" | "CLOSED";

// The funnel stages a contact walks. Everything the dashboard reports is a
// GROUP BY over this column, so it is the one place a contact's position lives.
export type ContactStage =
  | "UPLOADED"
  | "INVALID"
  | "L1_SENT"
  | "L1_INTERESTED"
  | "L1_DECLINED"
  | "L1_NO_REPLY"
  | "DOC_RECEIVED"
  | "DOC_VERIFIED"
  | "L2_QUEUED"
  | "L2_INTERESTED"
  | "L2_DECLINED"
  | "L2_NO_KEY"
  | "L3_QUEUED"
  | "CONFIRMED"
  | "CLOSED_LOST";

export type Campaign = {
  id: string;
  code: string;
  name: string;
  status: CampaignStatus;
  createdBy: string;
  createdAt: string;
};

export type Contact = {
  id: string;
  campaignId: string;
  name: string;
  phoneDigits: string;
  city: string | null;
  refId: string | null;
  stage: ContactStage;
  ownerAgent: string | null;
  note: string | null;
  invalidReason: string | null;
  createdAt: string;
  updatedAt: string;
};

function rowToCampaign(r: any): Campaign {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
  };
}

export function rowToContact(r: any): Contact {
  return {
    id: r.id,
    campaignId: r.campaign_id,
    name: r.name,
    phoneDigits: r.phone_digits,
    city: r.city,
    refId: r.ref_id,
    stage: r.stage,
    ownerAgent: r.owner_agent,
    note: r.note,
    invalidReason: r.invalid_reason,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export class CampaignsRepo {
  constructor(private pool: pg.Pool) {}

  async create(c: { code: string; name: string; createdBy: string }): Promise<Campaign> {
    const { rows } = await this.pool.query(
      `INSERT INTO campaigns(code,name,created_by) VALUES ($1,$2,$3) RETURNING *`,
      [c.code, c.name, c.createdBy],
    );
    return rowToCampaign(rows[0]);
  }

  async list(): Promise<Campaign[]> {
    const { rows } = await this.pool.query(`SELECT * FROM campaigns ORDER BY created_at DESC`);
    return rows.map(rowToCampaign);
  }

  async get(id: string): Promise<Campaign | null> {
    const { rows } = await this.pool.query(`SELECT * FROM campaigns WHERE id=$1`, [id]);
    return rows[0] ? rowToCampaign(rows[0]) : null;
  }

  async setStatus(id: string, status: CampaignStatus): Promise<void> {
    await this.pool.query(`UPDATE campaigns SET status=$2 WHERE id=$1`, [id, status]);
  }
}
